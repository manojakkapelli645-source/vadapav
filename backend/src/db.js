require('dotenv').config();
const path = require('path');
const fs = require('fs');
// Node.js built-in SQLite (Node 22.13+ / 24). No extra package or compilation needed.
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const raw = new DatabaseSync(path.join(dataDir, 'restaurant.db'));
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const db = {
  exec: sql => raw.exec(sql),
  prepare: sql => raw.prepare(sql),
  transaction: fn => (...args) => {
    raw.exec('BEGIN');
    try { const r = fn(...args); raw.exec('COMMIT'); return r; }
    catch (e) { raw.exec('ROLLBACK'); throw e; }
  },
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'customer',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otps (
  phone TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price REAL NOT NULL,
  description TEXT DEFAULT '',
  veg INTEGER NOT NULL DEFAULT 1,
  available INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS tables_ (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER UNIQUE NOT NULL,
  seats INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  table_id INTEGER REFERENCES tables_(id),
  party_size INTEGER NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  status TEXT NOT NULL,             -- confirmed | waiting | arrived | completed | cancelled | no_show
  qr_token TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_code TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  booking_id INTEGER REFERENCES bookings(id),
  status TEXT NOT NULL DEFAULT 'placed',  -- placed | preparing | served | completed | cancelled
  total REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  menu_item_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  qty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_no TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  booking_id INTEGER REFERENCES bookings(id),
  subtotal REAL NOT NULL,
  gst REAL NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'unpaid',   -- unpaid | pay_at_counter | paid
  method TEXT,                             -- online | offline
  txn_ref TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE TABLE IF NOT EXISTS bill_orders (
  bill_id INTEGER NOT NULL REFERENCES bills(id),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  PRIMARY KEY (bill_id, order_id)
);
`);

// ---- seed tables ----
const TABLE_COUNT = parseInt(process.env.TABLE_COUNT || '12', 10);
const SEATS = parseInt(process.env.SEATS_PER_TABLE || '12', 10);
const have = db.prepare('SELECT COUNT(*) c FROM tables_').get().c;
if (have === 0) {
  const ins = db.prepare('INSERT INTO tables_ (number, seats) VALUES (?, ?)');
  for (let i = 1; i <= TABLE_COUNT; i++) ins.run(i, SEATS);
}

// ---- seed menu ----
if (db.prepare('SELECT COUNT(*) c FROM menu_items').get().c === 0) {
  const ins = db.prepare('INSERT INTO menu_items (name, category, price, description, veg) VALUES (?,?,?,?,?)');
  const items = [
    ['Paneer Tikka', 'Starters', 260, 'Tandoori marinated paneer cubes', 1],
    ['Veg Manchurian', 'Starters', 200, 'Crispy veg balls in spicy sauce', 1],
    ['Chicken 65', 'Starters', 290, 'Spicy fried chicken bites', 0],
    ['Dal Tadka', 'Main Course', 180, 'Yellow dal with ghee tadka', 1],
    ['Paneer Butter Masala', 'Main Course', 280, 'Creamy tomato gravy', 1],
    ['Butter Chicken', 'Main Course', 340, 'Classic creamy chicken gravy', 0],
    ['Veg Biryani', 'Rice & Breads', 240, 'Fragrant basmati with veggies', 1],
    ['Chicken Biryani', 'Rice & Breads', 320, 'Hyderabadi style', 0],
    ['Butter Naan', 'Rice & Breads', 50, 'Tandoor baked', 1],
    ['Tandoori Roti', 'Rice & Breads', 25, 'Whole wheat', 1],
    ['Gulab Jamun (2 pc)', 'Desserts', 90, 'Warm milk dumplings in syrup', 1],
    ['Ice Cream', 'Desserts', 100, 'Vanilla / chocolate', 1],
    ['Masala Chai', 'Drinks', 40, 'Hot spiced tea', 1],
    ['Fresh Lime Soda', 'Drinks', 70, 'Sweet / salted', 1],
    ['Cold Coffee', 'Drinks', 120, 'Thick and chilled', 1],
  ];
  const tx = db.transaction(() => items.forEach(i => ins.run(...i)));
  tx();
}

module.exports = db;
