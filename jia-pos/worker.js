// Free upload helper (Cloudflare Workers free plan: 100,000 requests/day, no card needed).
// Keeps the GitHub token on the server so owners and staff never see it.
//
// Setup:  dash.cloudflare.com > Workers & Pages > Create > "Hello World" Worker > Edit code > paste this file > Deploy.
//   Settings > Variables and Secrets:
//     GITHUB_TOKEN   (Secret)  your fine-grained GitHub token (Contents: read & write on abande.site only)
//     ALLOWED_ORIGIN (Text)    https://abande.site      (your website address, no trailing slash)
//   Copy the worker URL (https://xxxx.workers.dev) into UPLOAD_URL in JIA-POS.html and super-admin.html.

const API_KEY = 'AIzaSyBT8q7UuCQ-Rcm1uDXAVrBVMO5GC_7NHxI';   // Firebase web key (public by design)
const PROJECT = 'business-sync-d732b';
const REPO = 'itoayusername/abande.site', BRANCH = 'main';
const EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'zip'];

const json = (o, status, cors) => new Response(JSON.stringify(o), { status: status || 200, headers: { ...cors, 'Content-Type': 'application/json' } });

async function fsGet(idToken, path) {
  const r = await fetch('https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/' + path, { headers: { Authorization: 'Bearer ' + idToken } });
  return r.ok ? r.json() : null;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allow = env.ALLOWED_ORIGIN || '*';
    const cors = { 'Access-Control-Allow-Origin': allow === '*' ? '*' : (origin === allow ? origin : allow), 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return json({ error: 'Not found' }, 404, cors);
    if (!env.GITHUB_TOKEN) return json({ error: 'Upload is not configured.' }, 500, cors);

    // 1) Who is calling? Verify the Firebase sign-in token.
    const idToken = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
    if (!idToken) return json({ error: 'Sign in first.' }, 401, cors);
    const lk = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) });
    if (!lk.ok) return json({ error: 'Sign in again.' }, 401, cors);
    const email = ((await lk.json()).users || [{}])[0].email;
    if (!email) return json({ error: 'Sign in again.' }, 401, cors);

    // 2) Are they an approved owner, active staff member or super admin? (Firestore rules apply to this lookup.)
    const e = encodeURIComponent(email);
    const [ad, st, su] = await Promise.all([fsGet(idToken, 'admins/' + e), fsGet(idToken, 'staff/' + e), fsGet(idToken, 'superadmins/' + e)]);
    const isOwner = !!(ad && ad.fields && ad.fields.approved && ad.fields.approved.booleanValue === true);
    const isStaff = !!(st && st.fields && String((st.fields.status || {}).stringValue || 'Active').toLowerCase() !== 'inactive');
    const isSuper = !!su;
    if (!isOwner && !isStaff && !isSuper) return json({ error: 'Not allowed.' }, 403, cors);

    let body; try { body = await req.json(); } catch (x) { return json({ error: 'Bad request.' }, 400, cors); }
    const H = { Authorization: 'Bearer ' + env.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'jia-pos-upload' };
    const api = (p) => 'https://api.github.com/repos/' + REPO + '/contents/' + p.split('/').map(encodeURIComponent).join('/');

    if (body.action === 'delete') {
      const path = String(body.path || '');
      if (!path.startsWith('JIA-POS/Store/chat/') || path.includes('..')) return json({ error: 'Not allowed.' }, 403, cors);
      const g = await fetch(api(path) + '?ref=' + BRANCH, { headers: H });
      if (g.ok) { const j = await g.json(); await fetch(api(path), { method: 'DELETE', headers: H, body: JSON.stringify({ message: 'Remove expired chat file', sha: j.sha, branch: BRANCH }) }); }
      return json({ ok: true }, 200, cors);
    }

    if (body.action === 'upload') {
      const kind = body.kind, b64 = body.b64;
      if (!['image', 'chat'].includes(kind) || typeof b64 !== 'string' || !b64) return json({ error: 'Bad upload.' }, 400, cors);
      if (b64.length > 9 * 1024 * 1024) return json({ error: 'File is too large.' }, 400, cors);
      let ext = 'jpg';
      if (kind === 'chat') {
        ext = String(body.name || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!EXT.includes(ext)) return json({ error: 'That file type is not allowed.' }, 400, cors);
      } else {
        const head = atob(b64.slice(0, 8));
        if (head.charCodeAt(0) !== 0xff || head.charCodeAt(1) !== 0xd8) return json({ error: 'Photos must be JPEG.' }, 400, cors);
      }
      const rnd = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((n) => n.toString(16).padStart(2, '0')).join('');
      const path = 'JIA-POS/Store/' + (kind === 'image' ? 'images' : 'chat') + '/' + Date.now().toString(36) + rnd + '.' + ext;
      const r = await fetch(api(path), { method: 'PUT', headers: H, body: JSON.stringify({ message: kind === 'image' ? 'Add product photo' : 'Chat attachment', content: b64, branch: BRANCH }) });
      if (!r.ok) return json({ error: 'Upload failed (' + r.status + ').' }, 502, cors);
      return json({ url: 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/' + path, path }, 200, cors);
    }
    return json({ error: 'Bad request.' }, 400, cors);
  }
};
