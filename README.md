# Scholarly

A student research repository where you can upload, browse, and rate academic papers and case studies. I built this because there was no decent place for students to actually publish their work and have others find it.

Live at [scholarlyst.netlify.app](https://scholarlyst.netlify.app)

---

## What it does

- Browse and search papers by title, author, keywords, or abstract
- Upload PDF, DOCX, or DOC files with a title, tags, and thumbnail
- Public author profiles showing all their published work
- Star ratings — stored per user so you can't just spam rate
- Google sign-in and email/password both work
- Auto-creates your profile on first Google login, no extra step needed

---

## Stack

Frontend is plain HTML, CSS, and JS — no framework. Backend logic runs through Netlify Functions so the Supabase service role key never touches the browser. Database and auth are on Supabase.

| Thing | How |
|---|---|
| Hosting | Netlify |
| Functions | Netlify Serverless (Node 18) |
| Auth | Supabase (Google OAuth + Email) |
| DB | Supabase / PostgreSQL |
| Storage | Supabase Storage (`paper-assets` bucket) |
| Packages | `@supabase/supabase-js`, `busboy`, `mammoth` |

---

## Folder structure

```
V3/
├── public/
│   ├── index.html        # home, search, paper feed
│   ├── dashboard.html    # upload and manage your papers
│   ├── paper.html        # single paper view + ratings
│   ├── author.html       # public author profile
│   ├── login.html
│   ├── signup.html
│   ├── account.html
│   ├── 404.html
│   └── style.css
├── netlify/
│   └── functions/
│       ├── upload-paper.js     # multipart upload handler
│       └── submit-rating.js    # rating write handler
├── supabase-schema.sql   # run this once in Supabase SQL Editor
├── netlify.toml
└── package.json
```

---

## Database

Three tables, all with RLS:

- `profiles` — linked to `auth.users`, holds name, college ID, department, bio, avatar
- `papers` — one per upload, stores title, abstract, tags, file URL, thumbnail, author ID
- `ratings` — one per user-paper pair, stores the star value (1–5)

---

## Setting it up

**Supabase**

1. Create a project at supabase.com
2. Open SQL Editor, paste `supabase-schema.sql`, run it
3. Create a public storage bucket called `paper-assets`
4. Enable Google OAuth under Authentication → Providers
5. Grab your Project URL, Anon Key, and Service Role Key

**Frontend**

In each HTML file, swap in your own credentials:
```js
const SUPABASE_URL  = 'https://your-project.supabase.co';
const SUPABASE_ANON = 'your-anon-key';
```

**Netlify**

Push to GitHub, import on Netlify, then add these in Site Settings → Environment Variables:
```
SUPABASE_URL              = https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY = your-service-role-key
```

Build command: `npm install` | Publish directory: `public`

Redirects and headers are already handled in `netlify.toml`.

---

## Things to know before deploying

- Supabase needs ECDSA/ES256 JWT — if you're getting auth errors, check that your project isn't using RSA keys
- Add your Netlify site URL to both Supabase (Auth → URL Configuration) and Google Cloud Console as an authorized redirect URI
- The `SUPABASE_URL` key triggers Netlify's secrets scanner even though it's not actually secret — that's already handled in `netlify.toml` via `SECRETS_SCAN_OMIT_KEYS`

---

## About

Made by Suyash Tidke — BCA student at MET Institute of Technology, Nashik. I do freelance web dev on the side and build actual projects, not just tutorials. This one went through a lot of debugging before it worked properly (Supabase JWT issues, OAuth profile creation, Netlify secrets scanner conflicts — all hit, all fixed).

GitHub: [@tidke-suyash](https://github.com/tidke-suyash)
