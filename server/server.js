// Server Cổng Truyện: tài khoản + phân quyền, truyện/chương, tu vi, giọng đọc Google, tải/gộp audio. Không cần cài thư viện.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DBF = process.env.DB_FILE || path.join(os.tmpdir(), 'congtruyen.json');
const TTS = process.env.TTS_BASE || 'https://translate.google.com/translate_tts';
const CACHE = path.join(os.tmpdir(), 'ct-tts'); fs.mkdirSync(CACHE, { recursive: true });
const ROLES = ['doc', 'tac-gia', 'qtv', 'admin'];
let db; try { db = JSON.parse(fs.readFileSync(DBF, 'utf8')); } catch { db = { users: {}, tok: {}, stories: [], reads: {}, seq: 1 }; }
const save = () => { try { fs.writeFileSync(DBF, JSON.stringify(db)); } catch (e) { console.error('Lỗi lưu:', e.message); } };
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
function mkUser(name, pw, role) { const salt = crypto.randomBytes(8).toString('hex'); return db.users[name.toLowerCase()] = { name, salt, hash: hash(pw, salt), role, exp: 0 }; }
const AU = process.env.ADMIN_USER || 'admin';
if (!db.users[AU.toLowerCase()]) { const pw = process.env.ADMIN_PASS || crypto.randomBytes(5).toString('hex'); mkUser(AU, pw, 'admin'); save(); console.log(`Tài khoản admin: ${AU} / ${pw}`); }
const pub = u => ({ name: u.name, role: u.role, exp: u.exp });
const bad = (code, msg) => Object.assign(new Error(msg), { code });
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) { no(bad(413, 'Nội dung quá lớn')); req.destroy(); } }); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { no(bad(400, 'Dữ liệu không hợp lệ')); } }); });
const who = (req, u) => { const t = (req.headers.authorization || '').slice(7) || u.searchParams.get('token'); return db.users[db.tok[t]] || null; };
const need = (c, ...roles) => { if (!c.me) throw bad(401, 'Chưa đăng nhập'); if (roles.length && !roles.includes(c.me.role)) throw bad(403, 'Không đủ quyền'); };
const gain = (u, n) => { u.exp += n; save(); return { exp: u.exp, gained: n }; };
const view = (s, me) => ({ ...s, ae: (db.users[s.a.toLowerCase()] || {}).exp || 0 });
const story = id => db.stories.find(s => s.id == id) || (() => { throw bad(404, 'Không có truyện này'); })();

// ---- Giọng đọc Google (qua server) ----
function chunks(t, n = 180) { const o = []; for (const para of t.split(/\n+/)) { let s = para.trim(); while (s.length > n) { let i = s.lastIndexOf(' ', n); if (i < 60) i = n; o.push(s.slice(0, i)); s = s.slice(i).trim(); } if (s) o.push(s); } return o; }
async function speak(text) {
  const f = path.join(CACHE, crypto.createHash('sha1').update(text).digest('hex') + '.mp3');
  if (fs.existsSync(f)) return fs.readFileSync(f);
  const parts = [];
  for (const c of chunks(text)) {
    const r = await fetch(`${TTS}?ie=UTF-8&q=${encodeURIComponent(c)}&tl=vi&client=tw-ob`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw bad(502, 'Google từ chối tạo giọng đọc, thử lại sau');
    parts.push(Buffer.from(await r.arrayBuffer()));
  }
  const buf = Buffer.concat(parts); fs.writeFileSync(f, buf); return buf;
}
const chapterAudio = (s, i) => { const c = s.c[i]; if (!c) throw bad(404, 'Không có chương này'); return speak(c.t + '\n' + c.b.join('\n')); };

// ---- Định tuyến ----
const routes = []; const R = (m, re, fn) => routes.push([m, new RegExp('^' + re + '$'), fn]);
R('GET', '/health', c => send(c.res, 200, { ok: true }));
R('POST', '/api/register', async c => {
  const b = await body(c.req), n = String(b.name || '').trim(), p = String(b.password || '');
  if (n.length < 3 || n.length > 20) throw bad(400, 'Tên từ 3 đến 20 ký tự');
  if (p.length < 6) throw bad(400, 'Mật khẩu ít nhất 6 ký tự');
  if (db.users[n.toLowerCase()]) throw bad(409, 'Tên này đã có người dùng');
  const u = mkUser(n, p, 'doc'), t = crypto.randomBytes(24).toString('hex'); db.tok[t] = n.toLowerCase(); save(); send(c.res, 200, { token: t, user: pub(u) });
});
R('POST', '/api/login', async c => {
  const b = await body(c.req), u = db.users[String(b.name || '').trim().toLowerCase()];
  if (!u || u.hash !== hash(String(b.password || ''), u.salt)) throw bad(401, 'Sai tên hoặc mật khẩu');
  const t = crypto.randomBytes(24).toString('hex'); db.tok[t] = u.name.toLowerCase(); save(); send(c.res, 200, { token: t, user: pub(u) });
});
R('GET', '/api/me', c => { need(c); send(c.res, 200, pub(c.me)); });
R('GET', '/api/users', c => { need(c, 'admin'); send(c.res, 200, Object.values(db.users).map(pub)); });
R('POST', '/api/users/([^/]+)/role', async c => {
  need(c, 'admin'); const b = await body(c.req), u = db.users[decodeURIComponent(c.p[0]).toLowerCase()];
  if (!u) throw bad(404, 'Không có tài khoản này'); if (!ROLES.includes(b.role)) throw bad(400, 'Vai trò không hợp lệ');
  if (u === c.me) throw bad(400, 'Không tự đổi vai trò của mình'); u.role = b.role; save(); send(c.res, 200, pub(u));
});
R('GET', '/api/stories', c => { const mod = c.me && ['qtv', 'admin'].includes(c.me.role); send(c.res, 200, db.stories.filter(s => !s.hide || mod).map(s => view(s))); });
R('POST', '/api/stories', async c => {
  need(c, 'tac-gia', 'admin'); const b = await body(c.req), t = String(b.t || '').trim();
  if (!t) throw bad(400, 'Thiếu tên truyện');
  const id = db.seq++, s = { id, t, k: ['o', 't', 'a'].includes(b.k) ? b.k : 'o', g: String(b.g || 'Tiên hiệp'), a: c.me.name, h: (id * 47 + 150) % 360, f: 0, d: String(b.d || 'Truyện mới đăng.'), hide: false, c: [] };
  db.stories.unshift(s); save(); send(c.res, 200, view(s));
});
R('POST', '/api/stories/(\\d+)/chapters', async c => {
  need(c, 'tac-gia', 'admin'); const s = story(c.p[0]); if (s.a !== c.me.name && c.me.role !== 'admin') throw bad(403, 'Đây không phải truyện của bạn');
  const b = await body(c.req), t = String(b.t || '').trim(), x = String(b.b || '').trim(); if (!t || !x) throw bad(400, 'Thiếu tiêu đề hoặc nội dung');
  s.c.push({ t, b: x.split(/\n+/) }); send(c.res, 200, gain(db.users[s.a.toLowerCase()] || c.me, 20));
});
R('POST', '/api/stories/(\\d+)/hide', c => { need(c, 'qtv', 'admin'); const s = story(c.p[0]); s.hide = !s.hide; save(); send(c.res, 200, { hide: s.hide }); });
R('POST', '/api/read', async c => {   // đọc chương lần đầu: độc giả +10, tác giả +3
  need(c); const b = await body(c.req), s = story(b.story); if (!s.c[b.ch]) throw bad(404, 'Không có chương này');
  const k = s.id + '-' + b.ch, r = db.reads[c.me.name.toLowerCase()] ||= {};
  if (r[k]) return send(c.res, 200, { exp: c.me.exp, gained: 0 }); r[k] = 1;
  const a = db.users[s.a.toLowerCase()]; if (a && a !== c.me) a.exp += 3; send(c.res, 200, gain(c.me, 10));
});
const last = new Map();
R('POST', '/api/listen', c => {   // nghe online: +1 mỗi ~10 giây
  need(c); const now = Date.now(); if (now - (last.get(c.me.name) || 0) < 8000) return send(c.res, 200, { exp: c.me.exp, gained: 0 });
  last.set(c.me.name, now); send(c.res, 200, gain(c.me, 1));
});
R('GET', '/api/tts', async c => { const s = story(c.u.searchParams.get('story')), b = await chapterAudio(s, +c.u.searchParams.get('ch')); c.res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': b.length }); c.res.end(b); });
R('GET', '/api/audio', async c => {   // gộp nhiều chương thành một file mp3
  const s = story(c.u.searchParams.get('story')), ids = (c.u.searchParams.get('ch') || '').split(',').filter(Boolean).map(Number);
  if (!ids.length || ids.length > 10) throw bad(400, 'Chọn từ 1 đến 10 chương');
  const bufs = []; for (const i of ids) bufs.push(await chapterAudio(s, i)); const b = Buffer.concat(bufs);
  c.res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': b.length, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(s.t)}.mp3` }); c.res.end(b);
});

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, 'http://x');
  for (const [m, re, fn] of routes) { const x = m === req.method && re.exec(u.pathname); if (x) { try { await fn({ req, res, u, p: x.slice(1), me: who(req, u) }); } catch (e) { if (!res.headersSent) send(res, e.code || 500, { error: e.message }); } return; } }
  send(res, 404, { error: 'Không tìm thấy' });
}).listen(PORT, () => console.log('Server chạy ở cổng', PORT));
