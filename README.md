# Digital Restaurant System

Customer app + Admin panel. **Backend and frontend are in separate folders.**

```
restaurant-system/
├─ backend/    Node.js + Express + SQLite (API, OTP login, tables, orders, QR, bills)
├─ frontend/   Plain HTML/JS pages (customer app + admin panel), no build step
└─ .vscode/    Settings to run everything from VS Code
```

## Features

**Customer app (http://localhost:3000)**
- Login with phone number + OTP
- Table booking: **12 tables, 12 seats on each table** (change in `backend/.env`)
- When all tables are full, a **waiting list with the estimated wait in minutes** is shown (even before booking)
- Browse the menu and place an order, which generates an **Order ID** (for example `ORD-7K2MQP`)
- Show the **entry QR code** on arrival at the restaurant
- The bill arrives by SMS and in the app, and can be paid **online** or **at the counter (offline)**

**Admin panel for restaurant staff (http://localhost:3000/admin.html)**
- Separate admin login (OTP, only for numbers listed in `ADMIN_PHONES`)
- Live status of all 12 tables (free / reserved / occupied) plus the waiting list with minutes
- All orders with their **Order ID**, and status updates (start preparing / served / cancel)
- Bookings list by date, and walk-in / phone bookings
- **QR scanner** (camera or typed code): identifies the customer and checks them in
- Bill generation (5% GST) sent to the customer by SMS, and marking offline payments as paid
- Menu management: add items, change prices, mark items unavailable

## Run it in VS Code

Requirement: **Node.js 22.13 or newer (22 LTS or 24)** from https://nodejs.org. The database is the SQLite built into Node.js, so nothing needs to be compiled. If you see "ExperimentalWarning: SQLite" on start, ignore it.

1. In VS Code choose `File → Open Folder` and open the **restaurant-system** folder.
2. Open a terminal (`Ctrl + ~`) and set up the backend:
   ```bash
   cd backend
   npm install
   copy .env.example .env        # Windows
   # cp .env.example .env        # Mac / Linux
   ```
3. Open `backend/.env` and put **your own mobile number in `ADMIN_PHONES=`** so you can log in as admin.
4. Start the backend (same terminal):
   ```bash
   npm start
   ```
   You should see: `backend running: http://localhost:4000`
5. Open a **new terminal** (the `+` button) and start the frontend:
   ```bash
   cd frontend
   npm start
   ```
6. Open in your browser:
   - Customer: http://localhost:3000
   - Admin: http://localhost:3000/admin.html

Shortcut: press `Ctrl+Shift+D`, pick **"Run Backend + Frontend"** and press ▶ (do steps 2 and 3 once first).

## How OTP works

- **Test mode (default, `DEV_OTP=true`)**: the OTP is printed in the backend terminal and also shown on the login screen. No SMS is sent.
- **Real SMS**: set `DEV_OTP=false` in `.env` and fill in `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM`. To use another SMS provider (MSG91, Fast2SMS, etc.), change the `sendSms()` function in `backend/src/server.js`; everything else stays the same.

## Table booking and waiting list logic

- A booking holds a table for `DINING_MINUTES` (default 90).
- The server picks the smallest table that fits the party and is free at that time.
- If no table is free, the booking goes on the **waiting list** and the customer sees "about X minutes". The estimate is based on when the first suitable table frees up and how many people are ahead in the queue.
- When someone cancels, a bill is paid, or a customer does not show up (after `GRACE_MINUTES`), the next person on the waiting list gets the table automatically and receives an SMS.

## About payments (important)

- **Offline**: the customer picks "Pay at the counter", and staff press "Mark as paid" in the admin panel.
- **Online**: this is currently a **demo**. The button marks the bill as paid and no real money moves. For real payments, connect a gateway such as Razorpay, PhonePe or Paytm at the `PAYMENT GATEWAY HOOK` in `backend/src/server.js` (create the order, verify the payment, then call `markPaid`). Do this before going live.

## Before going live

- Set `JWT_SECRET` to a long random string.
- Set `DEV_OTP=false`.
- Set `CORS_ORIGIN` to your frontend website's URL.
- Change `API_URL` in `frontend/config.js` to your backend's URL.
- The camera scanner needs the website to be served over **https** (plain http works on localhost).

## API at a glance

| Route | Purpose |
|---|---|
| `POST /api/auth/send-otp`, `/api/auth/verify-otp` | Phone OTP login |
| `GET /api/availability` | Whether a table is free, or how long the wait is |
| `POST /api/bookings`, `GET /api/bookings/mine`, `GET /api/bookings/:id/qr` | Bookings and QR code |
| `GET /api/menu`, `POST /api/orders`, `GET /api/orders/mine` | Menu, orders, Order ID |
| `GET /api/bills/mine`, `POST /api/bills/:id/pay` | Bills and payment |
| `/api/admin/*` | Admin: overview, orders, bookings, scan, bills, menu |
