const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { user: null, adminSession: false, items: [], city: '', pendingShow: null };
const toast = $('#toast');
// Search suggestions cover state/UT capitals and widely used city names. The field also accepts any city name.
const INDIAN_CITY_SUGGESTIONS = [
  'Agartala','Agra','Ahmedabad','Aizawl','Ajmer','Alappuzha','Aligarh','Amaravati','Amritsar','Anand','Anantapur','Asansol','Aurangabad','Ayodhya',
  'Bengaluru','Bareilly','Bathinda','Belagavi','Bhagalpur','Bharatpur','Bhilai','Bhilwara','Bhopal','Bhubaneswar','Bidar','Bikaner','Bilaspur','Bokaro','Chandigarh','Chennai','Coimbatore','Cuttack',
  'Daman','Darjeeling','Davanagere','Dehradun','Delhi','Dhanbad','Dharamshala','Dibrugarh','Dimapur','Dispur','Durg','Durgapur',
  'Erode','Faridabad','Gandhinagar','Gangtok','Gaya','Ghaziabad','Gorakhpur','Greater Noida','Guntur','Gurugram','Guwahati','Gwalior',
  'Haldwani','Haridwar','Hisar','Howrah','Hubballi','Hyderabad','Imphal','Indore','Itanagar','Jabalpur','Jaipur','Jalandhar','Jalgaon','Jammu','Jamnagar','Jamshedpur','Jhansi','Jodhpur','Jorhat',
  'Kadapa','Kakinada','Kalaburagi','Kanchipuram','Kannur','Kanpur','Karimnagar','Karnal','Kavaratti','Kochi','Kohima','Kolhapur','Kolkata','Kollam','Korba','Kota','Kottayam','Kozhikode','Kurnool',
  'Leh','Lucknow','Ludhiana','Madurai','Mangaluru','Mathura','Meerut','Moradabad','Mumbai','Muzaffarpur','Mysuru','Nagaon','Nagpur','Nanded','Nashik','Navi Mumbai','Nellore','Noida','Panaji','Panipat','Patiala','Patna','Puducherry','Pune','Prayagraj',
  'Raipur','Rajahmundry','Rajkot','Ranchi','Rourkela','Roorkee','Rishikesh','Salem','Sambalpur','Shimla','Shillong','Shivamogga','Silchar','Silvassa','Siliguri','Srinagar','Solapur','Sonipat','Surat',
  'Thane','Thanjavur','Thiruvananthapuram','Thrissur','Tiruchirappalli','Tirunelveli','Tiruppur','Tirupati','Udaipur','Udupi','Ujjain','Vadodara','Varanasi','Vasco da Gama','Vellore','Vijayawada','Visakhapatnam','Vizianagaram','Warangal'
];

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const colorFor = (item, index = 0) => `${item.art_color || ['#315f78','#b7485a','#6359a8','#dd6e37'][index % 4]}`;
const prettyDate = value => new Date(value).toLocaleString('en-IN', { weekday:'short', day:'numeric', month:'short', hour:'numeric', minute:'2-digit' });

function notify(message) {
  toast.textContent = message; toast.classList.add('show');
  clearTimeout(notify.timer); notify.timer = setTimeout(() => toast.classList.remove('show'), 4200);
}
function openModal(id) { const modal = document.getElementById(id); modal.classList.add('open'); modal.setAttribute('aria-hidden','false'); }
function closeModal(id) { const modal = document.getElementById(id); modal.classList.remove('open'); modal.setAttribute('aria-hidden','true'); }
$$('[data-close]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.close)));
$$('.modal').forEach(modal => modal.addEventListener('click', e => { if (e.target === modal) closeModal(modal.id); }));
document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal.open').forEach(m => closeModal(m.id)); });

function available(item) { const query=state.city.trim().toLocaleLowerCase('en-IN');return item.shows.filter(show => !query || show.city.toLocaleLowerCase('en-IN').includes(query)); }
function card(item, index = 0) {
  const shows = available(item);
  return `<article class="movie-card" data-item="${item.id}" tabindex="0" role="button" aria-label="Book ${esc(item.title)}"><div class="movie-art" style="background:linear-gradient(145deg,#17232d,${colorFor(item,index)} 72%,#f26b45)"><span>${esc(item.certificate || (item.kind==='event'?'LIVE':'NOW SHOWING'))}</span><b>${esc(item.title.toUpperCase())}</b><small>${esc(item.language || '')}</small></div><div class="movie-info"><h3>${esc(item.title)}</h3><p>${esc(item.genre || (item.kind==='event'?'Live event':'Movie'))} · ${esc(item.language || 'All languages')}</p><div class="card-bottom"><span>${shows.length ? `${shows.length} show${shows.length===1?'':'s'} available` : 'No upcoming shows'}</span><b>${shows.length ? 'Book →' : 'Details'}</b></div></div></article>`;
}
function render() {
  const movies = state.items.filter(x => x.kind === 'movie');
  const events = state.items.filter(x => x.kind === 'event');
  $('#movies-grid').innerHTML = movies.length ? movies.map(card).join('') : '<p class="empty">No movies are listed for this city yet.</p>';
  $('#events-grid').innerHTML = events.length ? events.map((x,i) => `<article class="event-card" data-item="${x.id}" tabindex="0" role="button" style="background:linear-gradient(135deg,${colorFor(x,i)},#173a43)"><span class="tag">LIVE EXPERIENCE · ${esc(x.language)}</span><h3>${esc(x.title)}</h3><p>${esc(x.genre)} · ${available(x).length} upcoming show${available(x).length===1?'':'s'}</p><b>Find tickets →</b></article>`).join('') : '<p class="empty">No upcoming events are listed for this city yet.</p>';
  $('#movie-count').textContent = `${movies.length} titles`;
  $('#event-count').textContent = `${events.length} events`;
  loadRecommendations();
}
async function loadCatalog() {
  try {
    const [{items}, {user}] = await Promise.all([api('/api/catalog'), api('/api/me')]);
    state.items = items; state.adminSession = user?.role === 'admin'; state.user = state.adminSession ? null : user;
    const cities = [...new Set([...INDIAN_CITY_SUGGESTIONS,...items.flatMap(x => x.shows.map(s => s.city))].map(c=>c.trim()))].sort((a,b)=>a.localeCompare(b,'en-IN'));
    $('#india-city-options').innerHTML = cities.map(c => `<option value="${esc(c)}"></option>`).join('');
    $('#city-filter').value = state.city;
    updateAccountButton(); render();
  } catch (error) { notify(error.message); }
}
async function loadRecommendations() {
  try {
    const {items, personalized} = await api('/api/recommendations');
    $('#recommendation-note').textContent = personalized ? 'Matched to your language and genre preferences.' : 'Explore what’s popular, or sign in to personalize your picks.';
    $('#recommendations-grid').innerHTML = items.length ? items.slice(0,4).map(card).join('') : '<p class="empty">Add shows in the admin area to see recommendations here.</p>';
  } catch (error) { $('#recommendations-grid').innerHTML = `<p class="empty">${esc(error.message)}</p>`; }
}
function updateAccountButton() { $('#account-button').textContent = state.user ? state.user.name.split(' ')[0] : 'Sign in'; }

function showAccount() {
  if (!state.user) renderAuth('login'); else renderProfile();
  openModal('account-modal');
}
function renderAuth(tab = 'login') {
  $('#account-content').innerHTML = `<p class="eyebrow">WELCOME TO SHOWTIME HUB</p><h2 class="booking-title">${tab==='login'?'Sign in':'Create your account'}</h2><p class="booking-sub">${state.adminSession?'Admin accounts manage the site but cannot book tickets. Sign in with a customer account; your ticket will be emailed to that account’s email address.':tab==='login'?'Sign in to book seats and access your tickets.':'Save your preferences and get recommendations that fit.'}</p>
    <div class="auth-tabs"><button class="${tab==='login'?'active':''}" data-auth-tab="login">Sign in</button><button class="${tab==='register'?'active':''}" data-auth-tab="register">Create account</button></div>
    <form id="auth-form" class="stack-form"><label>${tab==='register'?'Your name':''}<input name="name" autocomplete="name" placeholder="Full name" ${tab==='register'?'required':''} ${tab==='login'?'hidden':''}></label><label>Email<input type="email" name="email" autocomplete="email" placeholder="you@example.com" required></label><label>Password<input type="password" name="password" autocomplete="${tab==='login'?'current-password':'new-password'}" minlength="8" placeholder="At least 8 characters" required></label>
    ${tab==='register'?`<label>Preferred language<select name="language"><option>Any</option>${['English','Hindi','Kannada','Tamil','Telugu','Malayalam','Bengali','Marathi'].map(x=>`<option>${x}</option>`).join('')}</select></label><fieldset><legend>Genres you enjoy</legend><div class="genre-picks">${['Action','Comedy','Drama','Romance','Thriller','Sci-fi','Music','Family'].map(x=>`<label><input type="checkbox" name="genres" value="${x}">${x}</label>`).join('')}</div></fieldset>`:''}
    <button class="confirm wide" type="submit">${tab==='login'?'Sign in':'Create account'}</button><p class="form-error" aria-live="polite"></p></form>`;
}
async function renderProfile() {
  const user = state.user;
  let bookings = [];
  try { bookings = (await api('/api/bookings')).bookings; } catch (error) { notify(error.message); }
  $('#account-content').innerHTML = `<p class="eyebrow">YOUR SHOWTIME HUB</p><h2 class="booking-title">Hi, ${esc(user.name.split(' ')[0])}</h2><p class="booking-sub">${esc(user.email)} · <button class="inline-link" id="logout-button">Sign out</button></p>
    <form id="preferences-form" class="stack-form preference-form"><h3>Your recommendations</h3><label>Preferred language<select name="language"><option ${user.preferred_language==='Any'?'selected':''}>Any</option>${['English','Hindi','Kannada','Tamil','Telugu','Malayalam','Bengali','Marathi'].map(x=>`<option ${user.preferred_language===x?'selected':''}>${x}</option>`).join('')}</select></label><fieldset><legend>Genres you enjoy</legend><div class="genre-picks">${['Action','Comedy','Drama','Romance','Thriller','Sci-fi','Music','Family'].map(x=>`<label><input type="checkbox" name="genres" value="${x}" ${user.preferred_genres.includes(x)?'checked':''}>${x}</label>`).join('')}</div></fieldset><button class="confirm" type="submit">Save preferences</button></form>
    <h3 class="ticket-heading">Your tickets</h3><div class="ticket-list">${bookings.length?bookings.map(b=>`<article class="ticket-row"><div><b>${esc(b.title)}</b><p>${esc(prettyDate(b.starts_at))} · ${esc(b.venue_name)}, ${esc(b.city)}</p><p>Seats ${esc(b.seats)} · Code ${esc(b.booking_code)}</p></div><div class="ticket-right"><b>₹${Number(b.total_amount).toFixed(0)}</b><small class="${b.status==='cancelled'?'cancelled':''}">${esc(b.status)} · email ${esc(b.email_status)}</small>${b.status==='confirmed'&&b.email_status!=='sent'?`<button class="small-action" data-resend="${b.id}">Resend ticket</button>`:''}</div></article>`).join(''):'<p class="empty">Your confirmed bookings will appear here.</p>'}</div>`;
}
$('#account-button').addEventListener('click', showAccount);
$('#preferences-button').addEventListener('click', showAccount);
$('#city-filter').addEventListener('input', e => { state.city=e.target.value; render(); });

$('#account-content').addEventListener('click', async e => {
  const tab=e.target.closest('[data-auth-tab]');
  if(tab) return renderAuth(tab.dataset.authTab);
  const resend=e.target.closest('[data-resend]');if(resend){resend.disabled=true;try{const result=await api(`/api/bookings/${resend.dataset.resend}/resend-email`,{method:'POST',body:'{}'});notify(result.message);await renderProfile();}catch(error){notify(error.message);resend.disabled=false;}return;}
  if(e.target.id==='logout-button') { try { await api('/api/auth/logout',{method:'POST',body:'{}'}); state.user=null; closeModal('account-modal'); updateAccountButton(); render(); notify('You are signed out.'); } catch(error){notify(error.message);} }
});
$('#account-content').addEventListener('submit', async e => {
  e.preventDefault(); const form=e.target; const errorBox=$('.form-error',form);
  try {
    if(form.id==='auth-form') {
      const data=new FormData(form),isRegister=!!data.get('name');
      const payload={email:data.get('email'),password:data.get('password')};
      let url='/api/auth/login';
      if(isRegister){url='/api/auth/register';payload.name=data.get('name');payload.language=data.get('language');payload.genres=data.getAll('genres');}
      const result=await api(url,{method:'POST',body:JSON.stringify(payload)});state.user=result.user;state.adminSession=false;updateAccountButton();await render();closeModal('account-modal');notify(`Welcome${isRegister?' to ShowTime Hub':''}, ${state.user.name.split(' ')[0]}!`);
      if(state.pendingShow){const pending=state.pendingShow;state.pendingShow=null;openBooking(pending.item,pending.showId);}
    } else if(form.id==='preferences-form') {
      const data=new FormData(form),result=await api('/api/preferences',{method:'PUT',body:JSON.stringify({language:data.get('language'),genres:data.getAll('genres')})});state.user=result.user;await loadRecommendations();notify('Your preferences are saved.');
    }
  } catch(error) { if(errorBox)errorBox.textContent=error.message;else notify(error.message); }
});

document.addEventListener('click', e => {
  const itemCard=e.target.closest('[data-item]'); if(itemCard) { const item=state.items.find(x=>x.id===Number(itemCard.dataset.item)); if(item) openBooking(item); }
});
document.addEventListener('keydown', e => { if((e.key==='Enter'||e.key===' ')&&e.target.matches('[data-item]')) {e.preventDefault();e.target.click();} });

async function openBooking(item, showId = null) {
  if(!item) return;
  const shows=available(item);
  if(!shows.length){notify('No upcoming shows are available for this title.');return;}
  const chosenShow=shows.find(s=>s.id===showId)||shows[0];
  if(!state.user){state.pendingShow={item,showId:chosenShow.id};renderAuth('login');openModal('account-modal');notify('Sign in or create an account to book tickets.');return;}
  $('#booking-content').innerHTML=`<p class="eyebrow">BOOK YOUR TICKETS</p><h2 class="booking-title">${esc(item.title)}</h2><p class="booking-sub">${esc(item.genre)} · ${esc(item.language)} · ${esc(item.certificate)}</p><label class="show-label">Choose a venue and showtime<select id="show-choice" class="show-choice">${shows.map(s=>`<option value="${s.id}" ${s.id===chosenShow.id?'selected':''}>${esc(s.venue_name)} · ${esc(s.city)} · ${esc(prettyDate(s.starts_at))} · ₹${Number(s.price).toFixed(0)}</option>`).join('')}</select></label><div id="seat-picker"><div class="seat-loading">Loading seat availability…</div></div>`;
  openModal('booking-modal'); await loadSeats(item,chosenShow.id);
}
async function loadSeats(item,showId) {
  const host=$('#seat-picker');
  try {
    const {show,seats}=await api(`/api/shows/${showId}/seats`);
    if(!host.isConnected)return;
    const selected=new Set();
    host.innerHTML=`<p class="show-detail">${esc(show.venue_name)} · ${esc(show.city)} · ${esc(prettyDate(show.starts_at))}</p><div class="screen">ALL EYES THIS WAY</div><div class="seats">${seats.map(seat=>`<button type="button" class="seat ${seat.booked?'taken':''}" data-seat-id="${seat.id}" ${seat.booked?'disabled':''} aria-label="${esc(seat.seat_code)}${seat.booked?' booked':''}">${esc(seat.seat_code)}</button>`).join('')}</div><div class="legend"><span><i></i>Available</span><span><i class="chosen"></i>Selected</span><span><i class="taken"></i>Booked</span></div><div class="booking-footer"><div class="total" id="booking-total">Select 1–8 seats<b>₹0</b></div><button class="confirm" id="confirm-booking">Confirm booking</button></div><p class="email-note">Ticket email goes to ${esc(state.user.email)}. Delivery status appears after booking.</p>`;
    const updateTotal=()=>{$('#booking-total').innerHTML=`${selected.size?`${selected.size} seat${selected.size===1?'':'s'} selected`:'Select 1–8 seats'}<b>₹${(selected.size*show.price).toFixed(0)}</b>`;};
    $$('.seat:not(.taken)',host).forEach(seat=>seat.addEventListener('click',()=>{const id=Number(seat.dataset.seatId);if(selected.has(id)){selected.delete(id);seat.classList.remove('selected');}else if(selected.size<8){selected.add(id);seat.classList.add('selected');}else notify('You can select up to 8 seats per booking.');updateTotal();}));
    $('#confirm-booking',host).addEventListener('click',async()=>{
      if(!selected.size){notify('Choose at least one available seat.');return;}
      const button=$('#confirm-booking',host);button.disabled=true;button.textContent='Confirming…';
      try{const result=await api('/api/bookings',{method:'POST',body:JSON.stringify({showId,seatIds:[...selected]})});closeModal('booking-modal');await loadCatalog();notify(`${result.booking.booking_code} · ${result.emailMessage}`);}
      catch(error){button.disabled=false;button.textContent='Confirm booking';notify(error.message);if(error.message.includes('just booked'))loadSeats(item,showId);}
    });
  }catch(error){host.innerHTML=`<p class="form-error">${esc(error.message)}</p>`;}
}
$('#booking-content').addEventListener('change', e => { if(e.target.id==='show-choice'){const itemTitle=$('.booking-title','#booking-content').textContent;const item=state.items.find(x=>x.title===itemTitle);if(item)loadSeats(item,Number(e.target.value));} });

loadCatalog();
