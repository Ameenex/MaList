// MaList submission relay — a Cloudflare Worker.
//
// The site can't write to GitHub itself (that would mean shipping a GitHub key in a public
// page), so its forms POST here instead. This Worker checks the Turnstile anti-spam token,
// then opens the GitHub issue using a key that never leaves Cloudflare. Places, events and
// prices still wait for "/approve" before they reach data/data.json; city issue reports are
// posted straight away as public issues.
//
// Deploy: paste this file into the Worker's "Edit code" editor and click Deploy.
// Secrets the Worker needs (Settings → Variables and Secrets, type Secret):
//   GITHUB_TOKEN      fine-grained token for Ameenex/MaList with Issues: Read and write
//   TURNSTILE_SECRET  secret key of the "MaList" Turnstile widget

const REPO = 'Ameenex/MaList';
const ALLOWED_ORIGINS = ['https://ameenex.github.io', 'http://localhost:8000'];
const TYPES = ['place', 'event', 'price', 'issue'];
const MAX_BODY_BYTES = 8000;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function reply(origin, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

// Same rules as the approval script's clean(): no control characters or angle brackets.
function clean(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function turnstileOk(token, ip, secret) {
  if (!token) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const out = await res.json();
  return out.success === true;
}

async function createIssue(env, title, body, labels) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'malist-worker',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, labels }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.json();
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'POST') return reply(origin, 405, { error: 'Use POST.' });
    if (!ALLOWED_ORIGINS.includes(origin)) return reply(origin, 403, { error: 'Not allowed from this site.' });

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return reply(origin, 413, { error: 'Submission is too large.' });
    let req;
    try { req = JSON.parse(raw); } catch { return reply(origin, 400, { error: 'Invalid request.' }); }

    const ip = request.headers.get('CF-Connecting-IP');
    if (!(await turnstileOk(req.turnstileToken, ip, env.TURNSTILE_SECRET))) {
      return reply(origin, 400, { error: 'Anti-spam check failed. Please try again.' });
    }

    const type = req.type;
    if (!TYPES.includes(type) || !req.data || typeof req.data !== 'object') {
      return reply(origin, 400, { error: 'Unknown submission type.' });
    }
    const submittedBy = clean(req.name, 40);
    const label = clean(req.label, 80) || 'Submission';

    try {
      let issue;
      if (type === 'issue') {
        const d = req.data;
        const body = [
          `**${clean(d.category, 30)}** — ${clean(d.zone, 20)}`,
          '',
          clean(d.comment, 1000),
          '',
          `📍 ${clean(d.location, 150) || 'Location not specified'}`,
          '',
          `_Reported via MaList${submittedBy ? ` by ${submittedBy}` : ''}_`,
        ].join('\n');
        issue = await createIssue(env, `[Issue] ${label}`, body, ['city-issue']);
      } else {
        // Full validation happens in .github/scripts/accept-submission.js when you /approve.
        const payload = JSON.stringify({ v: 1, type, data: req.data, submittedBy }, null, 2);
        const body = [
          `Submitted through the MaList website${submittedBy ? ` by **${submittedBy}**` : ''}.`,
          'Comment `/approve` to publish it or `/reject` to decline.',
          '',
          '### Submission data',
          '',
          '```json',
          payload,
          '```',
        ].join('\n');
        issue = await createIssue(env, `[MaList] ${label}`, body, []);
      }
      return reply(origin, 200, { ok: true, url: issue.html_url, number: issue.number });
    } catch (e) {
      console.error(e);
      return reply(origin, 502, { error: 'Could not save the submission right now. Please try again later.' });
    }
  },
};
