const jwt = require('jsonwebtoken');

// Этот middleware вешаем на роуты, которые требуют авторизации.
// Он читает заголовок "Authorization: Bearer <token>", проверяет токен
// и, если всё ок, кладёт данные пользователя в req.user
function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Токен не предоставлен' });
  }

  const token = header.split(' ')[1];

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, role, email }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Токен недействителен или истёк' });
  }
}

// Дополнительный middleware: пропускает дальше только организаторов
function requireOrganizer(req, res, next) {
  if (req.user.role !== 'organizer') {
    return res.status(403).json({ error: 'Доступно только организаторам' });
  }
  next();
}

module.exports = { requireAuth, requireOrganizer };
