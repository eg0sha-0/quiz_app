const express = require('express');
const db = require('../db/init');
const { requireAuth, requireOrganizer } = require('../middleware/auth');

function createCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getUniqueCode() {
  let code = createCode();
  while (db.prepare('SELECT id FROM rooms WHERE code = ?').get(code)) {
    code = createCode();
  }
  return code;
}

function getRoomByCode(code) {
  return db
    .prepare(
      `SELECT rooms.*, quizzes.owner_id, quizzes.title as quiz_title,
              quizzes.category, quizzes.time_per_question
       FROM rooms
       JOIN quizzes ON quizzes.id = rooms.quiz_id
       WHERE rooms.code = ?`
    )
    .get(code);
}

function getQuizQuestions(quizId) {
  return db
    .prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY position ASC')
    .all(quizId);
}

function getQuestionWithOptions(questionId, includeCorrect = false) {
  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
  if (!question) return null;

  const options = db.prepare('SELECT * FROM options WHERE question_id = ?').all(question.id);
  return {
    ...question,
    options: options.map((option) => ({
      id: option.id,
      text: option.text,
      ...(includeCorrect ? { is_correct: !!option.is_correct } : {}),
    })),
  };
}

function getParticipants(roomId) {
  return db
    .prepare(
      `SELECT room_participants.id, room_participants.score,
              users.id as user_id, users.name, users.email
       FROM room_participants
       JOIN users ON users.id = room_participants.user_id
       WHERE room_participants.room_id = ?
       ORDER BY room_participants.score DESC, users.name ASC`
    )
    .all(roomId);
}

function getRoomState(code, includeCorrect = false) {
  const room = getRoomByCode(code);
  if (!room) return null;

  const questions = getQuizQuestions(room.quiz_id);
  const currentQuestion =
    room.current_question_index >= 0 && room.current_question_index < questions.length
      ? getQuestionWithOptions(questions[room.current_question_index].id, includeCorrect)
      : null;

  return {
    room: {
      id: room.id,
      code: room.code,
      status: room.status,
      current_question_index: room.current_question_index,
      question_started_at: room.question_started_at,
    },
    quiz: {
      id: room.quiz_id,
      title: room.quiz_title,
      category: room.category,
      time_per_question: room.time_per_question,
      questions_count: questions.length,
    },
    currentQuestion,
    participants: getParticipants(room.id),
  };
}

function emitRoom(io, code) {
  const state = getRoomState(code);
  if (state) {
    io.to(`room:${code}`).emit('room:update', state);
  }
}

function sameIds(left, right) {
  const a = [...left].map(Number).sort((x, y) => x - y);
  const b = [...right].map(Number).sort((x, y) => x - y);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function getElapsedSeconds(startedAt) {
  if (!startedAt) return 0;
  const startedAtMs = new Date(`${startedAt.replace(' ', 'T')}Z`).getTime();
  return Math.floor((Date.now() - startedAtMs) / 1000);
}

function createRoomsRouter(io) {
  const router = express.Router();

  router.use(requireAuth);

  router.get('/history/me', (req, res) => {
    if (req.user.role === 'organizer') {
      const rooms = db
        .prepare(
          `SELECT rooms.id, rooms.code, rooms.status, rooms.created_at,
                  quizzes.title as quiz_title, quizzes.category
           FROM rooms
           JOIN quizzes ON quizzes.id = rooms.quiz_id
           WHERE quizzes.owner_id = ?
           ORDER BY rooms.created_at DESC`
        )
        .all(req.user.id);

      return res.json({
        history: rooms.map((room) => ({
          ...room,
          participants: getParticipants(room.id),
        })),
      });
    }

    const history = db
      .prepare(
        `SELECT rooms.id, rooms.code, rooms.status, rooms.created_at,
                quizzes.title as quiz_title, quizzes.category,
                room_participants.score
         FROM room_participants
         JOIN rooms ON rooms.id = room_participants.room_id
         JOIN quizzes ON quizzes.id = rooms.quiz_id
         WHERE room_participants.user_id = ?
         ORDER BY rooms.created_at DESC`
      )
      .all(req.user.id);

    res.json({ history });
  });

  router.post('/', requireOrganizer, (req, res) => {
    const { quiz_id } = req.body;
    const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(quiz_id);

    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    if (quiz.owner_id !== req.user.id) return res.status(403).json({ error: 'This is not your quiz' });

    const questionsCount = db
      .prepare('SELECT COUNT(*) as count FROM questions WHERE quiz_id = ?')
      .get(quiz.id).count;

    if (questionsCount === 0) {
      return res.status(400).json({ error: 'Add at least one question before launch' });
    }

    const code = getUniqueCode();
    db.prepare(
      `INSERT INTO rooms (quiz_id, code, status, current_question_index)
       VALUES (?, ?, 'lobby', -1)`
    ).run(quiz.id, code);

    res.status(201).json(getRoomState(code));
  });

  router.get('/:code', (req, res) => {
    const state = getRoomState(req.params.code, req.user.role === 'organizer');
    if (!state) return res.status(404).json({ error: 'Room not found' });
    res.json(state);
  });

  router.post('/:code/join', (req, res) => {
    const room = getRoomByCode(req.params.code);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (req.user.role !== 'participant') {
      return res.status(403).json({ error: 'Only participants can join rooms' });
    }
    if (room.status === 'finished') {
      return res.status(400).json({ error: 'Room is already finished' });
    }

    db.prepare(
      `INSERT OR IGNORE INTO room_participants (room_id, user_id, score)
       VALUES (?, ?, 0)`
    ).run(room.id, req.user.id);

    emitRoom(io, room.code);
    res.json(getRoomState(room.code));
  });

  router.post('/:code/start', requireOrganizer, (req, res) => {
    const room = getRoomByCode(req.params.code);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.owner_id !== req.user.id) return res.status(403).json({ error: 'This is not your room' });

    db.prepare(
      `UPDATE rooms
       SET status = 'running', current_question_index = 0, question_started_at = datetime('now')
       WHERE id = ?`
    ).run(room.id);

    emitRoom(io, room.code);
    res.json(getRoomState(room.code, true));
  });

  router.post('/:code/next', requireOrganizer, (req, res) => {
    const room = getRoomByCode(req.params.code);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.owner_id !== req.user.id) return res.status(403).json({ error: 'This is not your room' });

    const questions = getQuizQuestions(room.quiz_id);
    const nextIndex = room.current_question_index + 1;

    if (nextIndex >= questions.length) {
      db.prepare("UPDATE rooms SET status = 'finished', question_started_at = NULL WHERE id = ?").run(room.id);
    } else {
      db.prepare(
        "UPDATE rooms SET current_question_index = ?, question_started_at = datetime('now') WHERE id = ?"
      ).run(nextIndex, room.id);
    }

    emitRoom(io, room.code);
    res.json(getRoomState(room.code, true));
  });

  router.post('/:code/finish', requireOrganizer, (req, res) => {
    const room = getRoomByCode(req.params.code);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.owner_id !== req.user.id) return res.status(403).json({ error: 'This is not your room' });

    db.prepare("UPDATE rooms SET status = 'finished', question_started_at = NULL WHERE id = ?").run(room.id);

    emitRoom(io, room.code);
    res.json(getRoomState(room.code, true));
  });

  router.post('/:code/answer', (req, res) => {
    const room = getRoomByCode(req.params.code);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (req.user.role !== 'participant') {
      return res.status(403).json({ error: 'Only participants can answer' });
    }
    if (room.status !== 'running') {
      return res.status(400).json({ error: 'Quiz is not running' });
    }
    if (getElapsedSeconds(room.question_started_at) > room.time_per_question) {
      return res.status(400).json({ error: 'Time is over for this question' });
    }

    const questions = getQuizQuestions(room.quiz_id);
    const question = questions[room.current_question_index];
    if (!question) return res.status(400).json({ error: 'Current question not found' });

    const selectedOptionIds = Array.isArray(req.body.selected_option_ids)
      ? req.body.selected_option_ids.map(Number)
      : [];
    if (selectedOptionIds.length === 0) {
      return res.status(400).json({ error: 'Choose at least one option' });
    }

    const participant = db
      .prepare('SELECT * FROM room_participants WHERE room_id = ? AND user_id = ?')
      .get(room.id, req.user.id);
    if (!participant) return res.status(403).json({ error: 'Join room before answering' });

    const existing = db
      .prepare('SELECT id FROM answers WHERE room_participant_id = ? AND question_id = ?')
      .get(participant.id, question.id);
    if (existing) return res.status(409).json({ error: 'Answer already submitted' });

    const correctOptionIds = db
      .prepare('SELECT id FROM options WHERE question_id = ? AND is_correct = 1')
      .all(question.id)
      .map((option) => option.id);

    const isCorrect = sameIds(selectedOptionIds, correctOptionIds);

    const saveAnswer = db.transaction(() => {
      db.prepare(
        `INSERT INTO answers (room_participant_id, question_id, selected_option_ids, is_correct)
         VALUES (?, ?, ?, ?)`
      ).run(participant.id, question.id, JSON.stringify(selectedOptionIds), isCorrect ? 1 : 0);

      if (isCorrect) {
        db.prepare('UPDATE room_participants SET score = score + 1 WHERE id = ?').run(participant.id);
      }
    });

    saveAnswer();
    emitRoom(io, room.code);

    res.status(201).json({
      is_correct: isCorrect,
      correct_option_ids: correctOptionIds,
      state: getRoomState(room.code),
    });
  });

  return router;
}

module.exports = { createRoomsRouter, getRoomState };
