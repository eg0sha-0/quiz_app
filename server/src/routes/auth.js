const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/init');

const router = express.Router();

// Генерирует JWT-токен для пользователя. Токен живёт 7 дней —
// для MVP этого достаточно, не усложняем refresh-токенами.
function createToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// POST /api/auth/register
router.post('/register', (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }

  if (!['organizer', 'participant'].includes(role)) {
    return res.status(400).json({ error: 'Некорректная роль' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);

  const result = db
    .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email, passwordHash, role);

  const user = {
    id: result.lastInsertRowid,
    name,
    email,
    role,
  };

  const token = createToken(user);
  res.status(201).json({ user, token });
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }

  const dbUser = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!dbUser) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }

  const passwordMatches = bcrypt.compareSync(password, dbUser.password_hash);
  if (!passwordMatches) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }

  const user = {
    id: dbUser.id,
    name: dbUser.name,
    email: dbUser.email,
    role: dbUser.role,
  };

  const token = createToken(user);
  res.json({ user, token });
});

// GET /api/auth/me — вернуть текущего пользователя по токену
// (пригодится фронтенду, чтобы восстанавливать сессию при обновлении страницы)
const { requireAuth } = require('../middleware/auth');
router.get('/me', requireAuth, (req, res) => {
  const dbUser = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.user.id);
  if (!dbUser) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ user: dbUser });
});

module.exports = router;
