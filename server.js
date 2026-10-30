// ShowTime Hub: dependency-free Node.js + SQLite server (Node 22.5+).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
loadEnv(path.join(ROOT, '.env'));
const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'showtime-hub.sqlite');
const COOKIE_NAME = 'showtime_session';
const SESSION_DAYS = 7;
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const nowIso = () => new Date().toISOString();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function checkPassword(password, encoded) {
  const [salt, digest] = String(encoded || '').split(':');
  if (!salt || !digest) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function send(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  res.end(body);
}
function cookieValue(req, name) {
  for (const item of (req.headers.cookie || '').split(';')) {
    const [key, ...value] = item.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}
function setCookie(res, token, maxAge = SESSION_DAYS * 86400) {
  res.setHeader('set-cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}
function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha(token), userId, Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400);
  setCookie(res, token);
}
function currentUser(req) {
  const token = cookieValue(req, COOKIE_NAME);
  if (!token) return null;
  const row = db.prepare(`SELECT u.id,u.name,u.email,u.role,u.preferred_language,u.preferred_genres
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(sha(token), Math.floor(Date.now() / 1000));
  return row ? { ...row, preferred_genres: JSON.parse(row.preferred_genres || '[]') } : null;
}
function currentCustomer(req) {
  const user = currentUser(req);
  return user && user.role !== 'admin' ? user : null;
}
async function bodyJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1_000_000) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
  }
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('Send valid JSON.'), { status: 400 }); }
}
const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const safeUser = row => row ? ({ id: row.id, name: row.name, email: row.email, role: row.role, preferred_language: row.preferred_language, preferred_genres: JSON.parse(row.preferred_genres || '[]') }) : null;
function catalogRows(where = 'm.active=1') {
  return db.prepare(`SELECT m.*, s.id show_id,s.starts_at,s.price,v.id venue_id,v.name venue_name,v.city,v.address,
    (SELECT COUNT(*) FROM seats se WHERE se.venue_id=v.id) seat_count
    FROM movies m LEFT JOIN shows s ON s.movie_id=m.id AND s.active=1 AND s.starts_at>?
    LEFT JOIN venues v ON v.id=s.venue_id WHERE ${where}
    ORDER BY m.kind,m.title,s.starts_at`).all(nowIso());
}
function groupCatalog(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.id)) map.set(r.id, { id:r.id,title:r.title,kind:r.kind,genre:r.genre,language:r.language,duration_minutes:r.duration_minutes,certificate:r.certificate,description:r.description,art_color:r.art_color,shows:[] });
    if (r.show_id) map.get(r.id).shows.push({ id:r.show_id,starts_at:r.starts_at,price:r.price,venue_id:r.venue_id,venue_name:r.venue_name,city:r.city,address:r.address,seat_count:r.seat_count });
  }
  return [...map.values()];
}
function requireAdmin(req, res) {
  const user = currentUser(req);
  if (!user || user.role !== 'admin') { send(res, 403, { error: 'Admin access required. Sign in with an admin account.' }); return null; }
  return user;
}

// SMTP over implicit TLS (port 465). Configure SMTP_* in .env to deliver real mail.
function smtpCommand(socket, command, expected) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error('SMTP response timed out')); }, 12000);
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (last.length >= 4 && /^\d{3} /.test(last)) {
        cleanup();
        const code = Number(last.slice(0,3));
        if (!expected.includes(code)) reject(new Error(`SMTP ${code}: ${lines.join(' ')}`)); else resolve(lines.join('\n'));
      }
    };
    const onError = error => { cleanup(); reject(error); };
    function cleanup() { clearTimeout(timer); socket.off('data', onData); socket.off('error', onError); }
    socket.on('data', onData); socket.on('error', onError);
    if (command) socket.write(command + '\r\n');
  });
}
async function sendTicketEmail(user, booking) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.MAIL_FROM) throw new Error('Email is not configured. Add SMTP settings to .env.');
  const port = Number(process.env.SMTP_PORT || 465);
  const socket = tls.connect({ host: process.env.SMTP_HOST, port, servername: process.env.SMTP_HOST });
  try {
    await new Promise((resolve,reject) => { socket.once('secureConnect',resolve); socket.once('error',reject); });
    await smtpCommand(socket, '', [220]);
    await smtpCommand(socket, `EHLO showtimehub.local`, [250]);
    await smtpCommand(socket, 'AUTH LOGIN', [334]);
    await smtpCommand(socket, Buffer.from(process.env.SMTP_USER).toString('base64'), [334]);
    await smtpCommand(socket, Buffer.from(process.env.SMTP_PASS).toString('base64'), [235]);
    await smtpCommand(socket, `MAIL FROM:<${process.env.MAIL_FROM}>`, [250]);
    await smtpCommand(socket, `RCPT TO:<${user.email}>`, [250,251]);
    await smtpCommand(socket, 'DATA', [354]);
    const fromName = process.env.MAIL_FROM_NAME || 'ShowTime Hub';
    const subject = `Your ShowTime Hub ticket ${booking.booking_code}`;
    const plain = `Hi ${user.name},\n\nYour booking is confirmed.\n${booking.title}\n${booking.starts_at}\n${booking.venue_name}, ${booking.city}\nSeats: ${booking.seats.join(', ')}\nBooking code: ${booking.booking_code}\nTotal: INR ${booking.total_amount.toFixed(2)}\n\nShow this email at the venue. Have a great time!`;
    const html = `<div style="font:16px Arial,sans-serif;color:#18232c;max-width:560px;margin:auto"><div style="background:#173a43;color:white;padding:24px;border-radius:12px 12px 0 0"><div style="color:#f7bd4a;font-size:12px;letter-spacing:2px">SHOWTIME HUB · YOUR TICKET</div><h1 style="margin:12px 0 0">${escapeHtml(booking.title)}</h1></div><div style="padding:24px;border:1px solid #e8e1d5;border-radius:0 0 12px 12px"><p>Hi ${escapeHtml(user.name)}, your booking is confirmed.</p><p><b>${escapeHtml(booking.starts_at)}</b><br>${escapeHtml(booking.venue_name)}, ${escapeHtml(booking.city)}</p><p>Seats: <b>${booking.seats.map(escapeHtml).join(', ')}</b></p><p>Booking code: <b>${booking.booking_code}</b></p><p>Total: <b>₹${booking.total_amount.toFixed(2)}</b></p><p style="color:#63717b">Show this email at the venue. Have a great time!</p></div></div>`;
    const boundary = `showtime_${crypto.randomBytes(8).toString('hex')}`;
    const raw = `From: ${fromName} <${process.env.MAIL_FROM}>\r\nTo: ${user.email}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${plain}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${html}\r\n--${boundary}--\r\n.`;
    await smtpCommand(socket, raw, [250]);
    await smtpCommand(socket, 'QUIT', [221]);
  } finally { socket.end(); }
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function api(req, res, pathname, url) {
  const method = req.method;
  if (pathname === '/api/health' && method === 'GET') return send(res,200,{ok:true,app:'ShowTime Hub'});
  if (pathname === '/api/catalog' && method === 'GET') return send(res,200,{items:groupCatalog(catalogRows())});
  if (pathname === '/api/me' && method === 'GET') return send(res,200,{user:currentUser(req)});
  if (pathname === '/api/recommendations' && method === 'GET') {
    const user=currentCustomer(req); const items=groupCatalog(catalogRows());
    const ranked=items.map(item=>({item,score:(user && user.preferred_language!=='Any' && item.language===user.preferred_language?4:0)+(user?item.genre.split(/[,·]/).some(g=>user.preferred_genres.some(p=>p.toLowerCase()===g.trim().toLowerCase()))?3:0:0)+(item.shows.length?1:0)})).sort((a,b)=>b.score-a.score || a.item.title.localeCompare(b.item.title));
    return send(res,200,{items:ranked.slice(0,6).map(x=>x.item),personalized:!!user});
  }
  if (pathname === '/api/auth/register' && method === 'POST') {
    const b=await bodyJson(req),name=text(b.name,80),email=text(b.email,120).toLowerCase(),password=String(b.password||'');
    if(name.length<2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length<8) return send(res,400,{error:'Enter your name, a valid email, and a password with at least 8 characters.'});
    const genres=Array.isArray(b.genres)?b.genres.map(x=>text(x,40)).filter(Boolean).slice(0,8):[];
    try { const info=db.prepare(`INSERT INTO users(name,email,password_hash,preferred_language,preferred_genres) VALUES(?,?,?,?,?)`).run(name,email,hashPassword(password),text(b.language||'Any',40),JSON.stringify(genres)); const row=db.prepare('SELECT id,name,email,role,preferred_language,preferred_genres FROM users WHERE id=?').get(Number(info.lastInsertRowid)); createSession(res,Number(info.lastInsertRowid)); return send(res,201,{user:safeUser(row)}); }
    catch(e){ if(String(e.message).includes('UNIQUE')) return send(res,409,{error:'That email already has an account. Sign in instead.'}); throw e; }
  }
  if (pathname === '/api/auth/login' && method === 'POST') {
    const b=await bodyJson(req),email=text(b.email,120).toLowerCase();
    const row=db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if(!row || !checkPassword(String(b.password||''),row.password_hash)) return send(res,401,{error:'Email or password is incorrect.'});
    if(b.adminOnly && row.role!=='admin') return send(res,403,{error:'This account does not have admin access.'});
    if(!b.adminOnly && row.role==='admin') return send(res,403,{error:'Please use the admin sign-in page.'});
    createSession(res,row.id); return send(res,200,{user:safeUser(row)});
  }
  if (pathname === '/api/auth/logout' && method === 'POST') {
    const token=cookieValue(req,COOKIE_NAME); if(token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token)); setCookie(res,'',0); return send(res,200,{ok:true});
  }
  if (pathname === '/api/preferences' && method === 'PUT') {
    const user=currentCustomer(req); if(!user) return send(res,401,{error:'Sign in with a customer account to save your preferences.'});
    const b=await bodyJson(req),genres=Array.isArray(b.genres)?b.genres.map(x=>text(x,40)).filter(Boolean).slice(0,8):[];
    db.prepare('UPDATE users SET preferred_language=?,preferred_genres=? WHERE id=?').run(text(b.language||'Any',40),JSON.stringify(genres),user.id);
    return send(res,200,{user:currentUser(req)});
  }
  if (pathname.startsWith('/api/shows/') && pathname.endsWith('/seats') && method==='GET') {
    const showId=Number(pathname.split('/')[3]);
    const show=db.prepare(`SELECT s.*,m.title,v.name venue_name,v.city FROM shows s JOIN movies m ON m.id=s.movie_id JOIN venues v ON v.id=s.venue_id WHERE s.id=? AND s.active=1`).get(showId);
    if(!show) return send(res,404,{error:'Show not found.'});
    const seats=db.prepare(`SELECT se.id,se.seat_code,CASE WHEN EXISTS(SELECT 1 FROM booking_seats bs JOIN bookings b ON b.id=bs.booking_id WHERE bs.seat_id=se.id AND b.show_id=? AND b.status='confirmed') THEN 1 ELSE 0 END booked FROM seats se WHERE se.venue_id=? ORDER BY se.seat_code`).all(showId,show.venue_id);
    return send(res,200,{show,seats});
  }
  if (pathname === '/api/bookings' && method==='POST') {
    const user=currentCustomer(req); if(!user) return send(res,401,{error:'Sign in with a customer account before booking.'});
    const b=await bodyJson(req),showId=Number(b.showId),seatIds=Array.isArray(b.seatIds)?[...new Set(b.seatIds.map(Number))]:[];
    if(!Number.isInteger(showId)||seatIds.length<1||seatIds.length>8||seatIds.some(x=>!Number.isInteger(x))) return send(res,400,{error:'Choose between 1 and 8 seats.'});
    const show=db.prepare(`SELECT s.*,m.title,v.name venue_name,v.city FROM shows s JOIN movies m ON m.id=s.movie_id JOIN venues v ON v.id=s.venue_id WHERE s.id=? AND s.active=1 AND m.active=1`).get(showId);
    if(!show||show.starts_at<=nowIso()) return send(res,404,{error:'That show is no longer available.'});
    const ticketRows=db.prepare(`SELECT id,seat_code FROM seats WHERE venue_id=? AND id IN (${seatIds.map(()=>'?').join(',')})`).all(show.venue_id,...seatIds);
    if(ticketRows.length!==seatIds.length) return send(res,400,{error:'One or more seats do not belong to this venue.'});
    const code=crypto.randomBytes(5).toString('hex').toUpperCase();
    const seats=ticketRows.map(s=>s.seat_code).sort();
    db.exec('BEGIN IMMEDIATE');
    let bookingId;
    try {
      const occupied=db.prepare(`SELECT COUNT(*) n FROM booking_seats bs JOIN bookings b ON b.id=bs.booking_id WHERE b.show_id=? AND b.status='confirmed' AND bs.seat_id IN (${seatIds.map(()=>'?').join(',')})`).get(showId,...seatIds).n;
      if(occupied) { db.exec('ROLLBACK'); return send(res,409,{error:'A seat you selected was just booked. Please choose different seats.'}); }
      const info=db.prepare('INSERT INTO bookings(booking_code,user_id,show_id,total_amount,email_status) VALUES(?,?,?,?,?)').run(code,user.id,showId,show.price*seatIds.length,'pending'); bookingId=Number(info.lastInsertRowid);
      const add=db.prepare('INSERT INTO booking_seats(booking_id,seat_id) VALUES(?,?)'); for(const id of seatIds)add.run(bookingId,id);
      db.exec('COMMIT');
    } catch(error) { try{db.exec('ROLLBACK')}catch{} throw error; }
    const booking={booking_code:code,title:show.title,starts_at:new Date(show.starts_at).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'}),venue_name:show.venue_name,city:show.city,seats,total_amount:show.price*seatIds.length};
    let emailStatus='sent',emailMessage=`Ticket sent to ${user.email}.`;
    try { await sendTicketEmail(user,booking); db.prepare("UPDATE bookings SET email_status='sent' WHERE id=?").run(bookingId); }
    catch(error) { emailStatus='not_configured'; emailMessage=`Booking confirmed. Ticket email could not be sent: ${error.message}`; db.prepare("UPDATE bookings SET email_status=? WHERE id=?").run(error.message.startsWith('Email is not configured')?'not_configured':'failed',bookingId); }
    return send(res,201,{booking,emailStatus,emailMessage});
  }
  if (pathname === '/api/bookings' && method==='GET') {
    const user=currentCustomer(req); if(!user) return send(res,401,{error:'Sign in with a customer account to see your tickets.'});
    const rows=db.prepare(`SELECT b.id,b.booking_code,b.total_amount,b.status,b.email_status,b.booked_at,m.title,m.kind,s.starts_at,v.name venue_name,v.city,GROUP_CONCAT(se.seat_code, ', ') seats
      FROM bookings b JOIN shows s ON s.id=b.show_id JOIN movies m ON m.id=s.movie_id JOIN venues v ON v.id=s.venue_id JOIN booking_seats bs ON bs.booking_id=b.id JOIN seats se ON se.id=bs.seat_id
      WHERE b.user_id=? GROUP BY b.id ORDER BY b.booked_at DESC`).all(user.id);
    return send(res,200,{bookings:rows});
  }
  let resendMatch=pathname.match(/^\/api\/bookings\/(\d+)\/resend-email$/);
  if(resendMatch&&method==='POST'){
    const user=currentCustomer(req);if(!user)return send(res,401,{error:'Sign in with a customer account to resend your ticket.'});
    const row=db.prepare(`SELECT b.id,b.booking_code,b.total_amount,b.user_id,b.status,u.name,u.email,m.title,s.starts_at,v.name venue_name,v.city,GROUP_CONCAT(se.seat_code, ',') seats
      FROM bookings b JOIN users u ON u.id=b.user_id JOIN shows s ON s.id=b.show_id JOIN movies m ON m.id=s.movie_id JOIN venues v ON v.id=s.venue_id JOIN booking_seats bs ON bs.booking_id=b.id JOIN seats se ON se.id=bs.seat_id
      WHERE b.id=? AND b.user_id=? GROUP BY b.id`).get(+resendMatch[1],user.id);
    if(!row)return send(res,404,{error:'Ticket booking not found.'});
    if(row.status!=='confirmed')return send(res,409,{error:'This booking is cancelled.'});
    try{await sendTicketEmail({name:row.name,email:row.email},{booking_code:row.booking_code,title:row.title,starts_at:new Date(row.starts_at).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'}),venue_name:row.venue_name,city:row.city,seats:row.seats.split(','),total_amount:row.total_amount});db.prepare("UPDATE bookings SET email_status='sent' WHERE id=?").run(row.id);return send(res,200,{ok:true,message:`Ticket emailed to ${row.email}.`});}
    catch(error){db.prepare("UPDATE bookings SET email_status=? WHERE id=?").run(error.message.startsWith('Email is not configured')?'not_configured':'failed',row.id);return send(res,503,{error:`Email could not be sent: ${error.message}`});}
  }
  if (pathname.startsWith('/api/admin/')) {
    const admin=requireAdmin(req,res); if(!admin) return;
    const suffix=pathname.slice('/api/admin'.length);
    if(suffix==='/account/password'&&method==='POST'){
      const b=await bodyJson(req),row=db.prepare('SELECT password_hash FROM users WHERE id=?').get(admin.id),current=String(b.currentPassword||''),next=String(b.newPassword||'');
      if(!checkPassword(current,row.password_hash))return send(res,401,{error:'Current password is incorrect.'});
      if(next.length<12)return send(res,400,{error:'Choose a new password with at least 12 characters.'});
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(next),admin.id);return send(res,200,{ok:true});
    }
    if(suffix==='/dashboard'&&method==='GET') return send(res,200,{
      counts:{movies:db.prepare("SELECT COUNT(*) n FROM movies WHERE active=1 AND kind='movie'").get().n,events:db.prepare("SELECT COUNT(*) n FROM movies WHERE active=1 AND kind='event'").get().n,venues:db.prepare('SELECT COUNT(*) n FROM venues').get().n,shows:db.prepare('SELECT COUNT(*) n FROM shows WHERE active=1').get().n,bookings:db.prepare("SELECT COUNT(*) n FROM bookings WHERE status='confirmed'").get().n},
      movies:db.prepare('SELECT * FROM movies ORDER BY kind,title').all(),venues:db.prepare('SELECT v.*,COUNT(se.id) seat_count FROM venues v LEFT JOIN seats se ON se.venue_id=v.id GROUP BY v.id ORDER BY v.city,v.name').all(),
      shows:db.prepare(`SELECT s.*,m.title,m.kind,v.name venue_name,v.city FROM shows s JOIN movies m ON m.id=s.movie_id JOIN venues v ON v.id=s.venue_id ORDER BY s.starts_at DESC LIMIT 100`).all(),
      bookings:db.prepare(`SELECT b.id,b.booking_code,b.total_amount,b.status,b.email_status,b.booked_at,u.name customer,u.email,m.title,s.starts_at,v.name venue_name,GROUP_CONCAT(se.seat_code, ', ') seats FROM bookings b JOIN users u ON u.id=b.user_id JOIN shows s ON s.id=b.show_id JOIN movies m ON m.id=s.movie_id JOIN venues v ON v.id=s.venue_id JOIN booking_seats bs ON bs.booking_id=b.id JOIN seats se ON se.id=bs.seat_id GROUP BY b.id ORDER BY b.booked_at DESC LIMIT 50`).all()
    });
    let m=suffix.match(/^\/movies(?:\/(\d+))?$/);
    if(m&&method==='POST'){
      const b=await bodyJson(req); const title=text(b.title,120),kind=b.kind==='event'?'event':'movie';
      if(!title)return send(res,400,{error:'Title is required.'});
      const info=db.prepare('INSERT INTO movies(title,kind,genre,language,duration_minutes,certificate,description,art_color) VALUES(?,?,?,?,?,?,?,?)').run(title,kind,text(b.genre,100),text(b.language||'English',40),Number(b.duration_minutes)||null,text(b.certificate||'All ages',20),text(b.description,1000),/^#[0-9a-f]{6}$/i.test(b.art_color||'')?b.art_color:'#287d7c');return send(res,201,{id:Number(info.lastInsertRowid)});
    }
    if(m&&method==='PATCH'&&m[1]){const b=await bodyJson(req);const old=db.prepare('SELECT * FROM movies WHERE id=?').get(+m[1]);if(!old)return send(res,404,{error:'Title not found.'});db.prepare('UPDATE movies SET title=?,kind=?,genre=?,language=?,duration_minutes=?,certificate=?,description=?,art_color=?,active=? WHERE id=?').run(text(b.title??old.title,120),b.kind==='event'?'event':b.kind==='movie'?'movie':old.kind,text(b.genre??old.genre,100),text(b.language??old.language,40),Number(b.duration_minutes??old.duration_minutes)||null,text(b.certificate??old.certificate,20),text(b.description??old.description,1000),/^#[0-9a-f]{6}$/i.test(b.art_color||'')?b.art_color:old.art_color,b.active===undefined?old.active:(b.active?1:0),old.id);return send(res,200,{ok:true});}
    if(m&&method==='DELETE'&&m[1]){try{db.prepare('DELETE FROM movies WHERE id=?').run(+m[1]);return send(res,200,{ok:true})}catch{return send(res,409,{error:'This title is used by a show or booking. Deactivate it instead.'})}}
    m=suffix.match(/^\/venues(?:\/(\d+))?(?:\/seats)?$/);
    if(m&&method==='POST'&&suffix==='/venues') {const b=await bodyJson(req),name=text(b.name,100),city=text(b.city,60);if(!name||!city)return send(res,400,{error:'Venue name and city are required.'});const info=db.prepare('INSERT INTO venues(name,city,address) VALUES(?,?,?)').run(name,city,text(b.address,200));const id=Number(info.lastInsertRowid),add=db.prepare('INSERT INTO seats(venue_id,seat_code) VALUES(?,?)');for(const row of 'ABCDEFGH')for(let n=1;n<=8;n++)add.run(id,`${row}${n}`);return send(res,201,{id,seats:64});}
    if(m&&m[1]&&suffix.endsWith('/seats')&&method==='POST'){const venueId=+m[1],b=await bodyJson(req),row=text(b.row,1).toUpperCase(),from=Number(b.from),to=Number(b.to);if(!/^[A-Z]$/.test(row)||from<1||to>30||from>to)return send(res,400,{error:'Use one row letter and a valid seat number range (1–30).'});const venue=db.prepare('SELECT id FROM venues WHERE id=?').get(venueId);if(!venue)return send(res,404,{error:'Venue not found.'});const add=db.prepare('INSERT OR IGNORE INTO seats(venue_id,seat_code) VALUES(?,?)');let added=0;for(let i=from;i<=to;i++)added+=add.run(venueId,`${row}${i}`).changes;return send(res,201,{added});}
    if(m&&m[1]&&suffix.endsWith('/seats')&&method==='GET'){const venueId=+m[1],venue=db.prepare('SELECT id FROM venues WHERE id=?').get(venueId);if(!venue)return send(res,404,{error:'Venue not found.'});return send(res,200,{seats:db.prepare(`SELECT se.id,se.seat_code,EXISTS(SELECT 1 FROM booking_seats bs WHERE bs.seat_id=se.id) used FROM seats se WHERE se.venue_id=? ORDER BY se.seat_code`).all(venueId)});}
    if(m&&m[1]&&suffix==='/venues/'+m[1]&&method==='PATCH'){const b=await bodyJson(req),old=db.prepare('SELECT * FROM venues WHERE id=?').get(+m[1]);if(!old)return send(res,404,{error:'Venue not found.'});db.prepare('UPDATE venues SET name=?,city=?,address=? WHERE id=?').run(text(b.name??old.name,100),text(b.city??old.city,60),text(b.address??old.address,200),old.id);return send(res,200,{ok:true});}
    m=suffix.match(/^\/venues\/(\d+)$/);if(m&&method==='DELETE'){try{db.prepare('DELETE FROM venues WHERE id=?').run(+m[1]);return send(res,200,{ok:true})}catch{return send(res,409,{error:'This venue is used by a show or booking and cannot be deleted.'})}}
    m=suffix.match(/^\/seats\/(\d+)$/);if(m&&method==='DELETE'){try{const result=db.prepare('DELETE FROM seats WHERE id=?').run(+m[1]);if(!result.changes)return send(res,404,{error:'Seat not found.'});return send(res,200,{ok:true})}catch{return send(res,409,{error:'This seat has booking history and cannot be removed.'})}}
    m=suffix.match(/^\/shows(?:\/(\d+))?$/);
    if(m&&method==='POST'){const b=await bodyJson(req),movieId=Number(b.movie_id),venueId=Number(b.venue_id),price=Number(b.price),startsAt=new Date(b.starts_at);if(!db.prepare('SELECT id FROM movies WHERE id=? AND active=1').get(movieId)||!db.prepare('SELECT id FROM venues WHERE id=?').get(venueId)||!Number.isFinite(price)||price<0||Number.isNaN(+startsAt))return send(res,400,{error:'Choose a valid title, venue, date and price.'});const info=db.prepare('INSERT INTO shows(movie_id,venue_id,starts_at,price) VALUES(?,?,?,?)').run(movieId,venueId,startsAt.toISOString(),price);return send(res,201,{id:Number(info.lastInsertRowid)});}
    if(m&&m[1]&&method==='PATCH'){const b=await bodyJson(req),old=db.prepare('SELECT * FROM shows WHERE id=?').get(+m[1]);if(!old)return send(res,404,{error:'Show not found.'});const nextMovie=Number(b.movie_id)||old.movie_id,nextVenue=Number(b.venue_id)||old.venue_id;if(!db.prepare('SELECT id FROM movies WHERE id=?').get(nextMovie)||!db.prepare('SELECT id FROM venues WHERE id=?').get(nextVenue))return send(res,400,{error:'Choose an existing title and venue.'});const booked=db.prepare("SELECT 1 FROM bookings WHERE show_id=? AND status='confirmed' LIMIT 1").get(old.id);if(booked&&(nextMovie!==old.movie_id||nextVenue!==old.venue_id))return send(res,409,{error:'A show with confirmed tickets cannot change title or venue. Adjust its time or price, or cancel the bookings first.'});const starts=b.starts_at?new Date(b.starts_at):new Date(old.starts_at);if(Number.isNaN(+starts))return send(res,400,{error:'Invalid show date.'});const price=b.price===undefined?old.price:Number(b.price);if(!Number.isFinite(price)||price<0)return send(res,400,{error:'Ticket price must be a non-negative number.'});db.prepare('UPDATE shows SET movie_id=?,venue_id=?,starts_at=?,price=?,active=? WHERE id=?').run(nextMovie,nextVenue,starts.toISOString(),price,b.active===undefined?old.active:(b.active?1:0),old.id);return send(res,200,{ok:true});}
    if(m&&m[1]&&method==='DELETE'){const booking=db.prepare('SELECT 1 FROM bookings WHERE show_id=? LIMIT 1').get(+m[1]);if(booking)return send(res,409,{error:'This show has booking history. Deactivate it to preserve the records.'});db.prepare('DELETE FROM shows WHERE id=?').run(+m[1]);return send(res,200,{ok:true});}
    m=suffix.match(/^\/bookings\/(\d+)$/);if(m&&method==='PATCH'){const b=await bodyJson(req);if(b.status!=='cancelled')return send(res,400,{error:'Admin action supports cancellation only.'});db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(+m[1]);return send(res,200,{ok:true});}
    return send(res,404,{error:'Admin endpoint not found.'});
  }
  return send(res,404,{error:'API endpoint not found.'});
}

// Seed starter inventory and a separate administrator account on the first run.
const adminEmail=(process.env.ADMIN_EMAIL||'admin@showtimehub.local').toLowerCase();
if(!db.prepare('SELECT id FROM users WHERE email=?').get(adminEmail)) db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'admin')").run('ShowTime Admin',adminEmail,hashPassword(process.env.ADMIN_PASSWORD||'Admin@1234'));
if(db.prepare('SELECT COUNT(*) n FROM movies').get().n===0){
  const addMovie=db.prepare('INSERT INTO movies(title,kind,genre,language,duration_minutes,certificate,description,art_color) VALUES(?,?,?,?,?,?,?,?)');
  const movieIds=[addMovie.run('Midnight Metro','movie','Action, Thriller','Hindi',128,'UA 13+','A night train. A city of secrets. One last stop.','#315f78').lastInsertRowid,addMovie.run('The Last Summer','movie','Romance, Drama','English',112,'UA 7+','Two old friends find one more summer to get it right.','#b7485a').lastInsertRowid,addMovie.run('Orbit 9','movie','Sci-fi, Adventure','English',136,'UA 13+','The crew of a lost station gets one message from Earth.','#6359a8').lastInsertRowid,addMovie.run('Paper Tigers','movie','Comedy, Family','Kannada',104,'U','A family reunion that turns into a very unusual heist.','#dd6e37').lastInsertRowid,addMovie.run('Sonic Bloom','event','Music, Live','English',null,'All ages','An evening of new sounds and big energy.','#be4b3e').lastInsertRowid,addMovie.run('Laugh Track Live','event','Comedy, Live','English',null,'18+','A rotating lineup of Bengaluru comics.','#287d7c').lastInsertRowid];
  const v1=db.prepare('INSERT INTO venues(name,city,address) VALUES(?,?,?)').run('Luma Cinemas','Bengaluru','100 Feet Road, Indiranagar').lastInsertRowid;
  const v2=db.prepare('INSERT INTO venues(name,city,address) VALUES(?,?,?)').run('Sapphire Screens','Bengaluru','80 Feet Road, Koramangala').lastInsertRowid;
  const addSeat=db.prepare('INSERT INTO seats(venue_id,seat_code) VALUES(?,?)');for(const venueId of [v1,v2])for(const row of 'ABCDEFGH')for(let n=1;n<=8;n++)addSeat.run(venueId,`${row}${n}`);
  const addShow=db.prepare('INSERT INTO shows(movie_id,venue_id,starts_at,price) VALUES(?,?,?,?)');
  addShow.run(movieIds[0],v1,'2026-10-16T05:00:00.000Z',180);addShow.run(movieIds[0],v2,'2026-10-16T08:45:00.000Z',220);addShow.run(movieIds[1],v2,'2026-10-16T13:15:00.000Z',220);addShow.run(movieIds[2],v1,'2026-10-16T16:10:00.000Z',250);addShow.run(movieIds[4],v1,'2026-10-18T13:30:00.000Z',499);addShow.run(movieIds[5],v2,'2026-10-19T14:00:00.000Z',350);
}
db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Math.floor(Date.now()/1000));

const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const publicAssets=new Set(['/index.html','/admin.html','/style.css','/locations.css','/app.js','/admin.js']);
const server=http.createServer(async(req,res)=>{
  res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','same-origin');
  const url=new URL(req.url,'http://localhost');
  try {
    if(url.pathname.startsWith('/api/')) return await api(req,res,url.pathname,url);
    let requestPath=url.pathname==='/'?'/index.html':url.pathname==='/admin'?'/admin.html':url.pathname;
    if(!publicAssets.has(requestPath))return send(res,404,{error:'Page not found.'});
    const full=path.resolve(ROOT,'.'+decodeURIComponent(requestPath));if(!full.startsWith(ROOT+path.sep))return send(res,403,{error:'Forbidden.'});
    fs.readFile(full,(err,data)=>{if(err){res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});return res.end('Not found');}res.writeHead(200,{'content-type':mime[path.extname(full)]||'application/octet-stream','cache-control':'no-cache'});res.end(data)});
  } catch(error) { console.error(error); if(!res.headersSent)send(res,error.status||500,{error:error.status?error.message:'Something went wrong. Please try again.'}); }
});
server.listen(PORT,()=>{
  console.log(`ShowTime Hub running at http://localhost:${PORT}`);
  console.log(`Admin sign-in: ${adminEmail} / ${process.env.ADMIN_PASSWORD||'Admin@1234'} (change before sharing)`);
});
process.on('SIGINT',()=>{server.close(()=>{db.close();process.exit(0)})});
