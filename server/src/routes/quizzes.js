const express = require('express');
const db = require('../db/init');
const { requireAuth, requireOrganizer } = require('../middleware/auth');

const router = express.Router();

// Все роуты в этом файле требуют авторизации
router.use(requireAuth);

// ---------- КВИЗЫ ----------

// POST /api/quizzes — создать пустой квиз (без вопросов)
router.post('/', requireOrganizer, (req, res) => {
  const { title, category, time_per_question } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Название квиза обязательно' });
  }

  const result = db
    .prepare(
      `INSERT INTO quizzes (owner_id, title, category, time_per_question, status)
       VALUES (?, ?, ?, ?, 'draft')`
    )
    .run(req.user.id, title, category || null, time_per_question || 20);

  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ quiz });
});

// GET /api/quizzes — список квизов текущего организатора
router.get('/', requireOrganizer, (req, res) => {
  const quizzes = db
    .prepare('SELECT * FROM quizzes WHERE owner_id = ? ORDER BY created_at DESC')
    .all(req.user.id);
  res.json({ quizzes });
});

// GET /api/quizzes/:id — квиз со всеми вопросами и вариантами ответов
// (правильные ответы отдаём только владельцу квиза — участникам их видеть нельзя)
router.get('/:id', (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Квиз не найден' });

  const isOwner = quiz.owner_id === req.user.id;

  const questions = db
    .prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY position ASC')
    .all(quiz.id);

  const questionsWithOptions = questions.map((q) => {
    const options = db.prepare('SELECT * FROM options WHERE question_id = ?').all(q.id);
    return {
      ...q,
      options: options.map((o) => ({
        id: o.id,
        text: o.text,
        // is_correct прячем от не-владельца
        ...(isOwner ? { is_correct: !!o.is_correct } : {}),
      })),
    };
  });

  res.json({ quiz, questions: questionsWithOptions });
});

// PATCH /api/quizzes/:id — обновить название/категорию/время на вопрос/статус
router.patch('/:id', requireOrganizer, (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Квиз не найден' });
  if (quiz.owner_id !== req.user.id) return res.status(403).json({ error: 'Это не ваш квиз' });

  const { title, category, time_per_question, status } = req.body;

  if (status && !['draft', 'ready'].includes(status)) {
    return res.status(400).json({ error: 'Некорректный статус' });
  }

  db.prepare(
    `UPDATE quizzes SET
       title = COALESCE(?, title),
       category = COALESCE(?, category),
       time_per_question = COALESCE(?, time_per_question),
       status = COALESCE(?, status)
     WHERE id = ?`
  ).run(title, category, time_per_question, status, quiz.id);

  const updated = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(quiz.id);
  res.json({ quiz: updated });
});

// DELETE /api/quizzes/:id
router.delete('/:id', requireOrganizer, (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Квиз не найден' });
  if (quiz.owner_id !== req.user.id) return res.status(403).json({ error: 'Это не ваш квиз' });

  // ON DELETE CASCADE в схеме сам удалит вопросы/варианты/комнаты
  db.prepare('DELETE FROM quizzes WHERE id = ?').run(quiz.id);
  res.status(204).send();
});

// ---------- ВОПРОСЫ ----------

// POST /api/quizzes/:id/questions — добавить вопрос с вариантами ответов
// Тело: { text, image_url?, type: 'single'|'multiple', options: [{text, is_correct}] }
router.post('/:id/questions', requireOrganizer, (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Квиз не найден' });
  if (quiz.owner_id !== req.user.id) return res.status(403).json({ error: 'Это не ваш квиз' });

  const { text, image_url, type, options } = req.body;

  if (!text || !type || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({
      error: 'Нужны текст вопроса, тип и минимум 2 варианта ответа',
    });
  }

  if (!['single', 'multiple'].includes(type)) {
    return res.status(400).json({ error: 'Тип должен быть single или multiple' });
  }

  const correctCount = options.filter((o) => o.is_correct).length;
  if (correctCount === 0) {
    return res.status(400).json({ error: 'Должен быть хотя бы один правильный вариант' });
  }
  if (type === 'single' && correctCount > 1) {
    return res.status(400).json({ error: 'Для типа single может быть только один правильный вариант' });
  }

  // Транзакция: вопрос и все его варианты создаются вместе,
  // либо не создаётся ничего (если что-то упало посередине)
  const createQuestion = db.transaction(() => {
    const currentMax = db
      .prepare('SELECT COALESCE(MAX(position), -1) as maxPos FROM questions WHERE quiz_id = ?')
      .get(quiz.id).maxPos;

    const questionResult = db
      .prepare(
        `INSERT INTO questions (quiz_id, text, image_url, type, position)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(quiz.id, text, image_url || null, type, currentMax + 1);

    const questionId = questionResult.lastInsertRowid;

    const insertOption = db.prepare(
      'INSERT INTO options (question_id, text, is_correct) VALUES (?, ?, ?)'
    );
    for (const opt of options) {
      insertOption.run(questionId, opt.text, opt.is_correct ? 1 : 0);
    }

    return questionId;
  });

  const questionId = createQuestion();

  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
  const savedOptions = db.prepare('SELECT * FROM options WHERE question_id = ?').all(questionId);

  res.status(201).json({ question: { ...question, options: savedOptions } });
});

// DELETE /api/quizzes/:quizId/questions/:questionId
router.delete('/:quizId/questions/:questionId', requireOrganizer, (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.quizId);
  if (!quiz) return res.status(404).json({ error: 'Квиз не найден' });
  if (quiz.owner_id !== req.user.id) return res.status(403).json({ error: 'Это не ваш квиз' });

  db.prepare('DELETE FROM questions WHERE id = ? AND quiz_id = ?').run(
    req.params.questionId,
    quiz.id
  );
  res.status(204).send();
});

module.exports = router;
