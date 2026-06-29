// ============================================================
//  netlify/functions/submit-rating.js
//
//  Accepts a JSON POST body:
//    { paperId, stars, accessToken }
//
//  What this function does:
//    1. Validates the JWT — only logged-in users can rate.
//    2. Validates that `stars` is an integer 1–5.
//    3. Upserts into public.ratings (unique on paper_id + user_id),
//       so a second submission updates rather than errors.
//    4. Returns { success: true, avgRating, ratingCount }.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { paperId, stars, accessToken } = body;

    // ── Validate inputs ──────────────────────────────────────
    if (!paperId)     throw new Error('paperId is required.');
    if (!accessToken) throw new Error('accessToken is required.');

    const starsInt = parseInt(stars, 10);
    if (isNaN(starsInt) || starsInt < 1 || starsInt > 5) {
      throw new Error('stars must be an integer between 1 and 5.');
    }

    // ── Verify JWT ───────────────────────────────────────────
    const { data: { user }, error: authError } =
      await supabaseAdmin.auth.getUser(accessToken);

    if (authError || !user) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    // ── Upsert rating ────────────────────────────────────────
    // ON CONFLICT (paper_id, user_id) → update stars
    const { error: upsertError } = await supabaseAdmin
      .from('ratings')
      .upsert(
        { paper_id: paperId, user_id: user.id, stars: starsInt },
        { onConflict: 'paper_id,user_id' }
      );

    if (upsertError) throw new Error(`Rating upsert failed: ${upsertError.message}`);

    // ── Fetch updated aggregate from the view ────────────────
    const { data: stats, error: statsError } = await supabaseAdmin
      .from('paper_stats')
      .select('avg_rating, rating_count')
      .eq('paper_id', paperId)
      .single();

    if (statsError) throw new Error(`Stats fetch failed: ${statsError.message}`);

    return {
      statusCode : 200,
      headers    : { 'Content-Type': 'application/json' },
      body       : JSON.stringify({
        success     : true,
        avgRating   : stats.avg_rating,
        ratingCount : stats.rating_count
      })
    };

  } catch (err) {
    console.error('[submit-rating]', err);
    return {
      statusCode : 500,
      headers    : { 'Content-Type': 'application/json' },
      body       : JSON.stringify({ error: err.message })
    };
  }
};
