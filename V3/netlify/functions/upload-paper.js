const { createClient } = require('@supabase/supabase-js');
const Busboy           = require('busboy');
const crypto           = require('crypto');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ALLOWED_DOC_EXTS = new Set(['.pdf', '.docx', '.doc']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files  = {};
    const bb = Busboy({
      headers: {
        'content-type': event.headers['content-type'] || event.headers['Content-Type']
      },
      limits: { fileSize: 20 * 1024 * 1024 }
    });
    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        files[name] = { filename: info.filename, mimetype: info.mimeType, buffer: Buffer.concat(chunks) };
      });
    });
    bb.on('close', () => resolve({ fields, files }));
    bb.on('error', reject);
    const body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body);
    bb.write(body);
    bb.end();
  });
}

async function uploadToStorage(buffer, path, mimetype) {
  const { error } = await supabaseAdmin.storage
    .from('paper-assets')
    .upload(path, buffer, { contentType: mimetype, upsert: true });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  const { data } = supabaseAdmin.storage.from('paper-assets').getPublicUrl(path);
  return data.publicUrl;
}

function getExt(filename) {
  const idx = filename.lastIndexOf('.');
  return idx === -1 ? '' : filename.slice(idx).toLowerCase();
}

async function ensureProfile(authorId) {
  console.log('[ensureProfile] checking id:', authorId);

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('id', authorId)
    .limit(1);

  console.log('[ensureProfile] result — data:', JSON.stringify(data), 'error:', JSON.stringify(error));

  if (error) throw new Error(`Profile select failed: ${error.message}`);
  if (data && data.length > 0) return;

  console.log('[ensureProfile] inserting stub profile');
  const shortId = authorId.replace(/-/g, '').slice(0, 16).toUpperCase();

  const { error: insertErr } = await supabaseAdmin
    .from('profiles')
    .insert({
      id:          authorId,
      full_name:   'Author',
      college_id:  shortId,
      department:  'General',
      institution: 'Unknown Institution',
    });

  if (insertErr && insertErr.code !== '23505') {
    throw new Error(`Profile insert failed: ${insertErr.code} — ${insertErr.message}`);
  }

  console.log('[ensureProfile] stub created (or race-ignored)');
}

exports.handler = async (event) => {
  console.log('[upload-paper] method:', event.httpMethod);

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[upload-paper] MISSING ENV VARS — URL:', process.env.SUPABASE_URL ? 'set' : 'MISSING');
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Server misconfiguration: missing Supabase credentials.' }),
    };
  }

  try {
    const { fields, files } = await parseMultipart(event);
    const { title, summary, authorId } = fields;

    console.log('[upload-paper] authorId:', authorId, '| title:', title, '| summaryLen:', summary?.length, '| hasDoc:', !!files.docFile);

    // ── Validate authorId FIRST before it ever touches Supabase ──
    if (!authorId || authorId === 'undefined' || authorId === 'null') {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Session expired. Please log out and log back in.' }),
      };
    }
    if (!UUID_RE.test(authorId)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Invalid user ID ("${authorId}"). Please log out and log back in.` }),
      };
    }

    if (!files.docFile) throw new Error('No document file received.');
    if (!title)         throw new Error('Title is required.');
    if (!summary)       throw new Error('Summary is required.');

    const docExt = getExt(files.docFile.filename);
    if (!ALLOWED_DOC_EXTS.has(docExt)) {
      throw new Error(`Unsupported file type "${docExt}". Allowed: PDF, DOCX, DOC.`);
    }

    const summaryTrimmed = summary.trim();
    if (summaryTrimmed.length < 100)  throw new Error('Summary must be at least 100 characters.');
    if (summaryTrimmed.length > 1000) throw new Error('Summary must not exceed 1000 characters.');

    await ensureProfile(authorId);

    const paperId = crypto.randomUUID();

    let docMime = files.docFile.mimetype;
    if (docExt === '.pdf')  docMime = 'application/pdf';
    if (docExt === '.docx') docMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (docExt === '.doc')  docMime = 'application/msword';

    console.log('[upload-paper] uploading doc to storage');
    const docUrl = await uploadToStorage(
      files.docFile.buffer,
      `${authorId}/${paperId}/document${docExt}`,
      docMime
    );

    let thumbnailUrl = null;
    if (files.thumbnailFile && files.thumbnailFile.buffer.length > 0) {
      const thumbExt  = getExt(files.thumbnailFile.filename) || '.jpg';
      const thumbMime = files.thumbnailFile.mimetype || 'image/jpeg';
      thumbnailUrl = await uploadToStorage(
        files.thumbnailFile.buffer,
        `${authorId}/${paperId}/thumbnail${thumbExt}`,
        thumbMime
      );
    }

    console.log('[upload-paper] inserting paper row');
    const { error: insertError } = await supabaseAdmin.from('papers').insert({
      id:            paperId,
      author_id:     authorId,
      title:         title.trim(),
      paper_type:    'Research Paper',
      abstract:      summaryTrimmed,
      thumbnail_url: thumbnailUrl,
      doc_url:       docUrl,
      docx_url:      docUrl,
      html_content:  null,
      keywords:      [],
    });

    if (insertError) throw new Error(`Database insert failed: ${insertError.code} — ${insertError.message}`);

    console.log('[upload-paper] SUCCESS — paperId:', paperId);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, paperId }),
    };

  } catch (err) {
    console.error('[upload-paper] CAUGHT ERROR:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
