# ShowTime Hub

A full-stack ticket-booking mini project with an original brand and interface. It uses plain HTML, CSS and browser JavaScript, a Node.js HTTP server, and a persistent SQLite SQL database. It has customer accounts, an admin console, live seat availability, bookings, language/genre recommendations, and SMTP ticket emails.

## Run locally

1. Install Node.js 22.5 or newer.
2. Open a terminal in this folder and run `node server.js`.
3. Open [http://localhost:3000](http://localhost:3000).

There are no npm packages to install. The database file is created automatically from `schema.sql` on first start, and starter movies, events, shows, two Bengaluru venues, and their seat layouts are added automatically.

## Admin console

Open [http://localhost:3000/admin](http://localhost:3000/admin).

On a fresh local database, the starter administrator is:

- Email: `admin@showtimehub.local`
- Password: `Admin@1234`

Change these with `ADMIN_EMAIL` and `ADMIN_PASSWORD` environment variables before first startup if you plan to share the site or put it on a network. After signing in, use the Overview tab's password form to set a strong password without changing or deleting bookings.

Admins can add, edit, hide, and remove movies/events; add and edit venues; add or remove unused seats; schedule and hide shows; review bookings; and cancel bookings. Deleting inventory already referenced by bookings is blocked so booking history stays valid.

## Ticket email setup

Ticket bookings are saved even if email is not configured. To deliver real email, copy `.env.example` to `.env` and set `SMTP_HOST`, `SMTP_PORT` (465 for implicit TLS), `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM` to credentials from an SMTP provider. Restart the server. The booking result and account page show whether the email was sent, not configured, or failed. Tickets go to the signed-in customer's account email; `ADMIN_EMAIL` is only the administrator's login address. Admin accounts must use the separate admin portal and cannot book tickets. Use a provider app password where required; do not commit `.env` or share SMTP credentials.

## Booking and recommendations

Customers create an account with their email and password, then choose language and favorite genres. Recommendations rank available titles against those saved preferences. Customers select a real showtime, inspect currently booked seats, reserve up to eight available seats, and get a unique booking code. Seat allocation uses an SQLite write transaction and rejects seats already held by another confirmed booking.

The location field suggests Indian cities and accepts any typed city name. Cities with active venue showtimes are also added to the suggestions automatically; the admin adds venues and shows to make bookings available in a city.

This project demonstrates the booking workflow and sends confirmation tickets by email. It does not collect card details or integrate a payment gateway.

## Quick presentation walkthrough

1. Start the server and open the customer site. Change the city filter and browse a movie or live event.
2. Create a customer account and pick a preferred language and a couple of genres.
3. Open **For you** to show the preference-based recommendations, then open a title, choose a venue/showtime, and select available seats.
4. Confirm the booking. Show its booking code and email status, then open the account button to show the saved ticket.
5. Open `/admin` in a new tab and sign in with the admin account. Add a movie or event, create a showtime, and open **Venues & seats** to manage seat inventory.

The customer UI uses browser JavaScript to call the Node API. The API validates credentials, recommendations, show inventory, and booking requests. SQLite stores accounts, preferences, titles, venues, seat layouts, showtimes, bookings, and sessions. SMTP sends the confirmation ticket email.

## Data and configuration

- `server.js` — API, authentication, ticket email, and static web server.
- `schema.sql` — SQLite tables, foreign keys, checks, and indexes.
- `index.html`, `app.js`, `style.css` — customer website.
- `admin.html`, `admin.js` — separate admin portal.
- `.env.example` — server, administrator, and email configuration names.

The SQLite file defaults to `showtime-hub.sqlite` beside the server. Set `DB_FILE` to place it elsewhere. For a public deployment, use HTTPS, a strong unique admin password, a reliable SMTP provider, backups, and a production Node service manager.
