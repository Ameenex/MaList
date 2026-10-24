// Handles "/approve" and "/reject" comments on MaList submission issues.
// Untrusted issue text is only ever parsed as JSON, validated against a strict schema and
// written to data/data.json. It is never interpolated into a shell command or executed.
const fs = require('fs');

const DATA_PATH = 'data/data.json';
const TITLE_PREFIX = '[MaList]';
const ZONES = ['male', 'phase1', 'phase2'];
const CATEGORIES = ['fihaara', 'clinic', 'services'];
const MAX_ITEMS = 5000;

function clean(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function required(value, max, label) {
  const v = clean(value, max);
  if (!v) throw new Error(`"${label}" is missing.`);
  return v;
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`"${label}" must be one of: ${allowed.join(', ')}.`);
  return value;
}

function isoDate(value, label) {
  const s = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`"${label}" must be a date like 2026-12-31.`);
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error(`"${label}" is not a real date.`);
  return s;
}

function validate(type, d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Submission data is not an object.');
  if (type === 'place') {
    return {
      kind: 'shops',
      item: {
        name: required(d.name, 80, 'name'),
        address: required(d.address, 120, 'address'),
        category: oneOf(d.category, CATEGORIES, 'category'),
        zone: oneOf(d.zone, ZONES, 'zone'),
        freeFloorDelivery: d.freeFloorDelivery === true,
        acceptsViber: d.acceptsViber === true,
      },
    };
  }
  if (type === 'event') {
    const startDate = isoDate(d.startDate, 'startDate');
    const endDate = d.endDate ? isoDate(d.endDate, 'endDate') : null;
    if (endDate && endDate < startDate) throw new Error('"endDate" is before "startDate".');
    return {
      kind: 'events',
      item: {
        title: required(d.title, 100, 'title'),
        description: clean(d.description, 500) || 'No description provided.',
        location: required(d.location, 100, 'location'),
        time: required(d.time, 40, 'time'),
        hostedBy: clean(d.hostedBy, 100) || null,
        zone: oneOf(d.zone, ZONES, 'zone'),
        startDate,
        endDate,
      },
    };
  }
  if (type === 'price') {
    const price = Number(d.price);
    if (!Number.isFinite(price) || price <= 0 || price > 100000) throw new Error('"price" must be a number above 0.');
    return {
      kind: 'commodities',
      item: {
        name: required(d.name, 80, 'name'),
        price: Math.round(price * 100) / 100,
        shop: required(d.shop, 80, 'shop'),
        zone: oneOf(d.zone, ZONES, 'zone'),
      },
    };
  }
  throw new Error('Unknown submission type.');
}

function parsePayload(body) {
  const marker = body.indexOf('### Submission data');
  const text = marker === -1 ? body : body.slice(marker);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No submission data found in the issue.');
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error('The submission data is not valid JSON.');
  }
  if (parsed.v !== 1) throw new Error('Unsupported submission version.');
  return parsed;
}

const ID_PREFIX = { shops: 'cs-', events: 'ce-', commodities: 'cp-' };

async function prepare({ github, context, core }) {
  const { owner, repo } = context.repo;
  const issue = context.payload.issue;
  const comment = context.payload.comment;
  core.setOutput('changed', 'false');

  if (!issue || issue.pull_request || issue.state !== 'open') return;
  if (!String(issue.title || '').startsWith(TITLE_PREFIX)) return;

  const command = String(comment.body || '').trim().split(/\s+/)[0].toLowerCase();
  if (command !== '/approve' && command !== '/reject') return;

  // Only people with write access to the repo can approve or reject.
  const perm = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: comment.user.login });
  if (!['admin', 'maintain', 'write'].includes(perm.data.permission)) {
    core.info(`${comment.user.login} is not allowed to run ${command}.`);
    return;
  }

  const say = (body) => github.rest.issues.createComment({ owner, repo, issue_number: issue.number, body });

  if (command === '/reject') {
    await say('Rejected — this submission will not be published.');
    await github.rest.issues.update({ owner, repo, issue_number: issue.number, state: 'closed', state_reason: 'not_planned' });
    return;
  }

  let checked;
  try {
    const payload = parsePayload(String(issue.body || ''));
    checked = validate(payload.type, payload.data);
  } catch (e) {
    await say(`Could not approve this submission: ${e.message}\n\nAsk the author to submit it again.`);
    return;
  }

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  for (const k of ['shops', 'events', 'commodities']) if (!Array.isArray(data[k])) data[k] = [];

  const list = data[checked.kind];
  const id = ID_PREFIX[checked.kind] + issue.number;
  if (list.some((x) => x.id === id)) {
    await say('This submission is already published.');
    return;
  }
  if (list.length >= MAX_ITEMS) {
    await say('The data file is full — remove old entries before approving more.');
    return;
  }

  list.push({
    id,
    ...checked.item,
    addedBy: issue.user.login, // taken from GitHub, never from the submitted data
    ts: Date.now(),
  });
  data.updated = new Date().toISOString();
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
  core.setOutput('changed', 'true');
}

async function finalize({ github, context }) {
  const { owner, repo } = context.repo;
  const number = context.payload.issue.number;
  await github.rest.issues.createComment({
    owner, repo, issue_number: number,
    body: 'Approved and added to the data file. It will show on the site within a few minutes. Thank you!',
  });
  await github.rest.issues.update({ owner, repo, issue_number: number, state: 'closed', state_reason: 'completed' });
}

module.exports = { prepare, finalize, validate, parsePayload, clean };
