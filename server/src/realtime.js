const jwt = require('jsonwebtoken');

function setupRealtime(io) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No token'));

    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('join-room', (code) => {
      socket.join(`room:${code}`);
    });
  });
}

module.exports = { setupRealtime };
