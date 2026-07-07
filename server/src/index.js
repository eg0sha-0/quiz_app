require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const quizzesRoutes = require('./routes/quizzes');
const { createRoomsRouter } = require('./routes/rooms');
const { setupRealtime } = require('./realtime');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL,
  },
});

app.use(cors({ origin: process.env.CLIENT_URL }));
// Увеличиваем лимит тела запроса, т.к. картинки вопросов будем передавать
// как base64-строки прямо в JSON (для MVP не усложняем загрузкой файлов)
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/quizzes', quizzesRoutes);
app.use('/api/rooms', createRoomsRouter(io));

setupRealtime(io);

// Простой health-check роут, чтобы проверить, что сервер жив
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
