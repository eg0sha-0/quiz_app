import React, { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { apiRequest, clearSession, getStoredSession, saveSession } from './api';

const emptyQuestion = {
  text: '',
  image_url: '',
  type: 'single',
  options: [
    { text: '', is_correct: true },
    { text: '', is_correct: false },
  ],
};

export default function App() {
  const [session, setSession] = useState(() => getStoredSession());
  const [authMode, setAuthMode] = useState('login');
  const [authForm, setAuthForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'organizer',
  });
  const [quizzes, setQuizzes] = useState([]);
  const [selectedQuiz, setSelectedQuiz] = useState(null);
  const [quizForm, setQuizForm] = useState({
    title: '',
    category: '',
    time_per_question: 20,
  });
  const [questionForm, setQuestionForm] = useState(emptyQuestion);
  const [activeRoom, setActiveRoom] = useState(null);
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [selectedOptionIds, setSelectedOptionIds] = useState([]);
  const [answerResult, setAnswerResult] = useState(null);
  const [timeLeft, setTimeLeft] = useState(null);
  const [history, setHistory] = useState([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const token = session?.token;
  const user = session?.user;
  const isOrganizer = user?.role === 'organizer';

  useEffect(() => {
    if (!token) return;

    apiRequest('/auth/me', { token })
      .then(({ user: freshUser }) => {
        const nextSession = { token, user: freshUser };
        setSession(nextSession);
        saveSession(nextSession);
      })
      .catch(() => {
        clearSession();
        setSession(null);
      });
  }, [token]);

  useEffect(() => {
    if (token && isOrganizer) {
      loadQuizzes();
    }
  }, [token, isOrganizer]);

  useEffect(() => {
    if (token) {
      loadHistory();
    }
  }, [token]);

  useEffect(() => {
    if (!token || !activeRoom?.room?.code) return;

    const socket = io('http://localhost:4000', {
      auth: { token },
    });

    socket.emit('join-room', activeRoom.room.code);
    socket.on('room:update', (state) => {
      if (state.room.code === activeRoom.room.code) {
        setActiveRoom(state);
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [token, activeRoom?.room?.code]);

  useEffect(() => {
    setSelectedOptionIds([]);
    setAnswerResult(null);
  }, [activeRoom?.currentQuestion?.id]);

  useEffect(() => {
    if (
      !activeRoom?.room?.question_started_at ||
      activeRoom.room.status !== 'running' ||
      !activeRoom.quiz?.time_per_question
    ) {
      setTimeLeft(null);
      return;
    }

    const updateTimeLeft = () => {
      const startedAt = new Date(
        `${activeRoom.room.question_started_at.replace(' ', 'T')}Z`
      ).getTime();
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setTimeLeft(Math.max(0, activeRoom.quiz.time_per_question - elapsed));
    };

    updateTimeLeft();
    const timerId = window.setInterval(updateTimeLeft, 1000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [
    activeRoom?.room?.question_started_at,
    activeRoom?.room?.status,
    activeRoom?.quiz?.time_per_question,
  ]);

  const selectedQuizSummary = useMemo(() => {
    if (!selectedQuiz) return null;
    const questionCount = selectedQuiz.questions?.length || 0;
    return `${questionCount} ${questionCount === 1 ? 'вопрос' : 'вопросов'}`;
  }, [selectedQuiz]);

  async function handleAuth(event) {
    event.preventDefault();
    setLoading(true);
    setStatus('');

    try {
      const path = authMode === 'login' ? '/auth/login' : '/auth/register';
      const body =
        authMode === 'login'
          ? { email: authForm.email, password: authForm.password }
          : authForm;

      const data = await apiRequest(path, { method: 'POST', body });
      const nextSession = { user: data.user, token: data.token };
      saveSession(nextSession);
      setSession(nextSession);
      setStatus('Готово, вы вошли в систему.');
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadQuizzes() {
    try {
      const data = await apiRequest('/quizzes', { token });
      setQuizzes(data.quizzes);
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function loadQuiz(id) {
    setLoading(true);
    setStatus('');

    try {
      const data = await apiRequest(`/quizzes/${id}`, { token });
      setSelectedQuiz(data);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadHistory() {
    try {
      const data = await apiRequest('/rooms/history/me', { token });
      setHistory(data.history);
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function createQuiz(event) {
    event.preventDefault();
    setLoading(true);
    setStatus('');

    try {
      const data = await apiRequest('/quizzes', {
        method: 'POST',
        token,
        body: {
          title: quizForm.title,
          category: quizForm.category || null,
          time_per_question: Number(quizForm.time_per_question),
        },
      });

      setQuizForm({ title: '', category: '', time_per_question: 20 });
      await loadQuizzes();
      await loadQuiz(data.quiz.id);
      setStatus('Квиз создан. Теперь можно добавить вопросы.');
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function addQuestion(event) {
    event.preventDefault();
    if (!selectedQuiz?.quiz?.id) return;

    setLoading(true);
    setStatus('');

    try {
      await apiRequest(`/quizzes/${selectedQuiz.quiz.id}/questions`, {
        method: 'POST',
        token,
        body: {
          text: questionForm.text,
          image_url: questionForm.image_url || null,
          type: questionForm.type,
          options: questionForm.options.map((option) => ({
            text: option.text,
            is_correct: Boolean(option.is_correct),
          })),
        },
      });

      setQuestionForm(emptyQuestion);
      await loadQuiz(selectedQuiz.quiz.id);
      setStatus('Вопрос добавлен.');
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function deleteQuestion(questionId) {
    if (!selectedQuiz?.quiz?.id) return;

    setLoading(true);
    setStatus('');

    try {
      await apiRequest(`/quizzes/${selectedQuiz.quiz.id}/questions/${questionId}`, {
        method: 'DELETE',
        token,
      });
      await loadQuiz(selectedQuiz.quiz.id);
      setStatus('Вопрос удалён.');
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function deleteQuiz(quizId) {
    setLoading(true);
    setStatus('');

    try {
      await apiRequest(`/quizzes/${quizId}`, {
        method: 'DELETE',
        token,
      });
      if (selectedQuiz?.quiz?.id === quizId) {
        setSelectedQuiz(null);
      }
      await loadQuizzes();
      setStatus('Квиз удалён.');
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function createRoom(quizId) {
    setLoading(true);
    setStatus('');

    try {
      const state = await apiRequest('/rooms', {
        method: 'POST',
        token,
        body: { quiz_id: quizId },
      });
      setActiveRoom(state);
      setStatus(`Комната создана. Код: ${state.room.code}`);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function joinRoom(event) {
    event.preventDefault();
    setLoading(true);
    setStatus('');
    setAnswerResult(null);
    setSelectedOptionIds([]);

    try {
      const state = await apiRequest(`/rooms/${roomCodeInput.trim()}/join`, {
        method: 'POST',
        token,
      });
      setActiveRoom(state);
      setStatus('Вы подключились к комнате.');
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function startRoom() {
    await changeRoom('/start', 'Квиз запущен.');
  }

  async function nextQuestion() {
    setSelectedOptionIds([]);
    setAnswerResult(null);
    await changeRoom('/next', 'Переход к следующему вопросу.');
  }

  async function finishRoom() {
    await changeRoom('/finish', 'Квиз завершён.');
    await loadHistory();
  }

  async function changeRoom(action, successMessage) {
    if (!activeRoom?.room?.code) return;
    setLoading(true);
    setStatus('');

    try {
      const state = await apiRequest(`/rooms/${activeRoom.room.code}${action}`, {
        method: 'POST',
        token,
      });
      setActiveRoom(state);
      setStatus(successMessage);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  }

  function toggleLiveOption(optionId) {
    const question = activeRoom?.currentQuestion;
    if (!question) return;

    if (question.type === 'single') {
      setSelectedOptionIds([optionId]);
      return;
    }

    setSelectedOptionIds((current) =>
      current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId]
    );
  }

  async function submitAnswer(event) {
    event.preventDefault();
    if (!activeRoom?.room?.code) return;

    setLoading(true);
    setStatus('');

    try {
      const result = await apiRequest(`/rooms/${activeRoom.room.code}/answer`, {
        method: 'POST',
        token,
        body: { selected_option_ids: selectedOptionIds },
      });
      setAnswerResult(result);
      setActiveRoom(result.state);
      await loadHistory();
      setStatus(result.is_correct ? 'Ответ верный.' : 'Ответ неверный.');
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function markReady(id) {
    setLoading(true);
    setStatus('');

    try {
      await apiRequest(`/quizzes/${id}`, {
        method: 'PATCH',
        token,
        body: { status: 'ready' },
      });
      await loadQuizzes();
      await loadQuiz(id);
      setStatus('Квиз переведён в статус готов.');
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    clearSession();
    setSession(null);
    setQuizzes([]);
    setSelectedQuiz(null);
    setActiveRoom(null);
    setHistory([]);
    setStatus('');
  }

  function handleQuestionImage(event) {
    const file = event.target.files?.[0];
    if (!file) {
      setQuestionForm((current) => ({ ...current, image_url: '' }));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setQuestionForm((current) => ({ ...current, image_url: reader.result }));
    };
    reader.readAsDataURL(file);
  }

  function updateOption(index, field, value) {
    setQuestionForm((current) => ({
      ...current,
      options: current.options.map((option, optionIndex) => {
        if (optionIndex !== index) return option;
        return { ...option, [field]: value };
      }),
    }));
  }

  function addOption() {
    setQuestionForm((current) => ({
      ...current,
      options: [...current.options, { text: '', is_correct: false }],
    }));
  }

  function removeOption(index) {
    setQuestionForm((current) => ({
      ...current,
      options: current.options.filter((_, optionIndex) => optionIndex !== index),
    }));
  }

  function toggleCorrect(index) {
    setQuestionForm((current) => ({
      ...current,
      options: current.options.map((option, optionIndex) => {
        if (current.type === 'single') {
          return { ...option, is_correct: optionIndex === index };
        }

        if (optionIndex !== index) return option;
        return { ...option, is_correct: !option.is_correct };
      }),
    }));
  }

  function changeQuestionType(type) {
    setQuestionForm((current) => ({
      ...current,
      type,
      options:
        type === 'single'
          ? current.options.map((option, index) => ({ ...option, is_correct: index === 0 }))
          : current.options,
    }));
  }

  function renderRoomPanel() {
    if (!activeRoom) return null;

    const question = activeRoom.currentQuestion;
    const isFinished = activeRoom.room.status === 'finished';

    return (
      <section className="panel live-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Live-комната</p>
            <h2>{activeRoom.quiz.title}</h2>
            <p className="muted">
              Код комнаты: <strong className="room-code">{activeRoom.room.code}</strong> · статус:{' '}
              {activeRoom.room.status}
            </p>
          </div>
          <button className="ghost" type="button" onClick={() => setActiveRoom(null)}>
            Закрыть
          </button>
        </div>

        {isOrganizer && (
          <div className="live-actions">
            <button
              className="primary"
              type="button"
              onClick={startRoom}
              disabled={loading || activeRoom.room.status !== 'lobby'}
            >
              Запустить
            </button>
            <button
              className="secondary"
              type="button"
              onClick={nextQuestion}
              disabled={loading || activeRoom.room.status !== 'running'}
            >
              Следующий вопрос
            </button>
            <button
              className="danger"
              type="button"
              onClick={finishRoom}
              disabled={loading || isFinished}
            >
              Завершить
            </button>
          </div>
        )}

        {question ? (
          <article className="live-question">
            <p className="muted">
              Вопрос {activeRoom.room.current_question_index + 1} из{' '}
              {activeRoom.quiz.questions_count}
            </p>
            {timeLeft !== null && (
              <p className={`timer ${timeLeft === 0 ? 'expired' : ''}`}>
                Осталось секунд: {timeLeft}
              </p>
            )}
            <h3>{question.text}</h3>
            {question.image_url && (
              <img className="question-image" src={question.image_url} alt="Изображение вопроса" />
            )}

            {!isOrganizer && activeRoom.room.status === 'running' && (
              <form className="form" onSubmit={submitAnswer}>
                <div className="answer-grid">
                  {question.options.map((option) => (
                    <label className="answer-option" key={option.id}>
                      <input
                        checked={selectedOptionIds.includes(option.id)}
                        onChange={() => toggleLiveOption(option.id)}
                        type={question.type === 'single' ? 'radio' : 'checkbox'}
                      />
                      {option.text}
                    </label>
                  ))}
                </div>
                <button
                  className="primary"
                  type="submit"
                  disabled={
                    loading ||
                    selectedOptionIds.length === 0 ||
                    Boolean(answerResult) ||
                    timeLeft === 0
                  }
                >
                  Отправить ответ
                </button>
              </form>
            )}

            {isOrganizer && (
              <ul>
                {question.options.map((option) => (
                  <li className={option.is_correct ? 'correct' : ''} key={option.id}>
                    {option.text}
                  </li>
                ))}
              </ul>
            )}

            {answerResult && (
              <p className={answerResult.is_correct ? 'result ok' : 'result bad'}>
                {answerResult.is_correct ? 'Верно' : 'Неверно'}
              </p>
            )}
          </article>
        ) : (
          <div className="empty-state inline">
            <h3>{isFinished ? 'Квиз завершён' : 'Ожидание запуска'}</h3>
            <p>
              {isFinished
                ? 'Итоговые баллы уже видны в таблице.'
                : 'Участники могут подключаться по коду комнаты.'}
            </p>
          </div>
        )}

        <div className="leaderboard">
          <h3>Участники и баллы</h3>
          {activeRoom.participants.length > 0 ? (
            activeRoom.participants.map((participant, index) => (
              <div className="leader-row" key={participant.id}>
                <span>
                  {index + 1}. {participant.name}
                </span>
                <strong>{participant.score}</strong>
              </div>
            ))
          ) : (
            <p className="muted">Пока никто не подключился.</p>
          )}
        </div>
      </section>
    );
  }

  function renderHistory() {
    return (
      <section className="panel history-panel">
        <div className="section-head">
          <div>
            <h2>История</h2>
            <p className="muted">
              {isOrganizer
                ? 'Проведённые комнаты и результаты участников.'
                : 'Ваши участия в квизах и набранные баллы.'}
            </p>
          </div>
          <button className="secondary" type="button" onClick={loadHistory}>
            Обновить
          </button>
        </div>

        <div className="history-list">
          {history.map((item) => (
            <article className="history-item" key={`${item.id}-${item.code}`}>
              <div>
                <strong>{item.quiz_title}</strong>
                <p className="muted">
                  Код {item.code} · {item.status} · {item.created_at}
                </p>
              </div>
              {isOrganizer ? (
                <div className="mini-leaderboard">
                  {item.participants?.length > 0 ? (
                    item.participants.map((participant) => (
                      <span key={participant.id}>
                        {participant.name}: {participant.score}
                      </span>
                    ))
                  ) : (
                    <span>Участников не было</span>
                  )}
                </div>
              ) : (
                <strong>{item.score} балл(ов)</strong>
              )}
            </article>
          ))}
          {history.length === 0 && <p className="muted">История пока пустая.</p>}
        </div>
      </section>
    );
  }

  if (!session) {
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <div>
            <p className="eyebrow">QuizFlow MVP</p>
            <h1>Вход в систему квизов</h1>
            <p className="muted">
              Зарегистрируйтесь как организатор, чтобы создавать квизы, или как участник для
              будущего подключения к комнатам.
            </p>
          </div>

          <div className="mode-switch">
            <button
              className={authMode === 'login' ? 'active' : ''}
              type="button"
              onClick={() => setAuthMode('login')}
            >
              Вход
            </button>
            <button
              className={authMode === 'register' ? 'active' : ''}
              type="button"
              onClick={() => setAuthMode('register')}
            >
              Регистрация
            </button>
          </div>

          <form className="form" onSubmit={handleAuth}>
            {authMode === 'register' && (
              <>
                <label>
                  Имя
                  <input
                    value={authForm.name}
                    onChange={(event) => setAuthForm({ ...authForm, name: event.target.value })}
                    placeholder="Алексей"
                    required
                  />
                </label>

                <label>
                  Роль
                  <select
                    value={authForm.role}
                    onChange={(event) => setAuthForm({ ...authForm, role: event.target.value })}
                  >
                    <option value="organizer">Организатор</option>
                    <option value="participant">Участник</option>
                  </select>
                </label>
              </>
            )}

            <label>
              Email
              <input
                type="email"
                value={authForm.email}
                onChange={(event) => setAuthForm({ ...authForm, email: event.target.value })}
                placeholder="mail@example.com"
                required
              />
            </label>

            <label>
              Пароль
              <input
                type="password"
                value={authForm.password}
                onChange={(event) => setAuthForm({ ...authForm, password: event.target.value })}
                placeholder="Минимум 6 символов"
                required
              />
            </label>

            <button className="primary" disabled={loading} type="submit">
              {loading ? 'Подождите...' : authMode === 'login' ? 'Войти' : 'Создать аккаунт'}
            </button>
          </form>

          {status && <p className="notice">{status}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Личный кабинет</p>
          <h1>{user.name}</h1>
          <p className="muted">{user.role === 'organizer' ? 'Организатор' : 'Участник'}</p>
        </div>
        <button className="ghost" type="button" onClick={logout}>
          Выйти
        </button>
      </header>

      {renderRoomPanel()}

      {!isOrganizer ? (
        <section className="panel participant-panel">
          <h2>Подключиться к квизу</h2>
          <p className="muted">Введите код комнаты, который показывает организатор.</p>
          <form className="form join-form" onSubmit={joinRoom}>
            <label>
              Код комнаты
              <input
                value={roomCodeInput}
                onChange={(event) => setRoomCodeInput(event.target.value)}
                placeholder="123456"
                maxLength="6"
                required
              />
            </label>
            <button className="primary" type="submit" disabled={loading}>
              Подключиться
            </button>
          </form>
        </section>
      ) : (
        <div className="workspace">
          <section className="panel">
            <div className="section-head">
              <div>
                <h2>Мои квизы</h2>
                <p className="muted">Создавайте черновики и наполняйте их вопросами.</p>
              </div>
              <button className="secondary" type="button" onClick={loadQuizzes}>
                Обновить
              </button>
            </div>

            <form className="form compact" onSubmit={createQuiz}>
              <label>
                Название
                <input
                  value={quizForm.title}
                  onChange={(event) => setQuizForm({ ...quizForm, title: event.target.value })}
                  placeholder="История веб-разработки"
                  required
                />
              </label>
              <label>
                Категория
                <input
                  value={quizForm.category}
                  onChange={(event) => setQuizForm({ ...quizForm, category: event.target.value })}
                  placeholder="IT"
                />
              </label>
              <label>
                Секунд на вопрос
                <input
                  min="5"
                  type="number"
                  value={quizForm.time_per_question}
                  onChange={(event) =>
                    setQuizForm({ ...quizForm, time_per_question: event.target.value })
                  }
                  required
                />
              </label>
              <button className="primary" disabled={loading} type="submit">
                Создать квиз
              </button>
            </form>

            <div className="quiz-list">
              {quizzes.map((quiz) => (
                <div
                  className={`quiz-item ${selectedQuiz?.quiz?.id === quiz.id ? 'selected' : ''}`}
                  key={quiz.id}
                >
                  <button className="quiz-open" type="button" onClick={() => loadQuiz(quiz.id)}>
                    <span>{quiz.title}</span>
                    <small>
                      {quiz.category || 'Без категории'} · {quiz.status}
                    </small>
                  </button>
                  <button
                    className="danger compact-danger"
                    type="button"
                    onClick={() => deleteQuiz(quiz.id)}
                    disabled={loading}
                  >
                    Удалить
                  </button>
                </div>
              ))}
              {quizzes.length === 0 && <p className="muted">Пока нет созданных квизов.</p>}
            </div>
          </section>

          <section className="panel">
            {selectedQuiz ? (
              <>
                <div className="section-head">
                  <div>
                    <h2>{selectedQuiz.quiz.title}</h2>
                    <p className="muted">{selectedQuizSummary}</p>
                  </div>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => markReady(selectedQuiz.quiz.id)}
                    disabled={
                      selectedQuiz.quiz.status === 'ready' ||
                      selectedQuiz.questions.length === 0 ||
                      loading
                    }
                  >
                    {selectedQuiz.quiz.status === 'ready' ? 'Уже готов' : 'Готов'}
                  </button>
                  <button
                    className="primary"
                    type="button"
                    onClick={() => createRoom(selectedQuiz.quiz.id)}
                    disabled={loading || selectedQuiz.questions.length === 0}
                  >
                    Запустить комнату
                  </button>
                </div>

                <form className="form" onSubmit={addQuestion}>
                  <label>
                    Текст вопроса
                    <textarea
                      value={questionForm.text}
                      onChange={(event) =>
                        setQuestionForm({ ...questionForm, text: event.target.value })
                      }
                      placeholder="Какой метод используется для отправки HTTP-запроса?"
                      required
                    />
                  </label>

                  <label>
                    Изображение вопроса
                    <input accept="image/*" type="file" onChange={handleQuestionImage} />
                  </label>

                  {questionForm.image_url && (
                    <img
                      className="question-image preview"
                      src={questionForm.image_url}
                      alt="Превью изображения вопроса"
                    />
                  )}

                  <label>
                    Тип ответа
                    <select
                      value={questionForm.type}
                      onChange={(event) => changeQuestionType(event.target.value)}
                    >
                      <option value="single">Один правильный ответ</option>
                      <option value="multiple">Несколько правильных ответов</option>
                    </select>
                  </label>

                  <div className="options-box">
                    {questionForm.options.map((option, index) => (
                      <div className="option-row" key={index}>
                        <input
                          aria-label="Правильный ответ"
                          checked={option.is_correct}
                          onChange={() => toggleCorrect(index)}
                          type={questionForm.type === 'single' ? 'radio' : 'checkbox'}
                        />
                        <input
                          value={option.text}
                          onChange={(event) => updateOption(index, 'text', event.target.value)}
                          placeholder={`Вариант ${index + 1}`}
                          required
                        />
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => removeOption(index)}
                          disabled={questionForm.options.length <= 2}
                          title="Удалить вариант"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button className="secondary" type="button" onClick={addOption}>
                      Добавить вариант
                    </button>
                  </div>

                  <button className="primary" disabled={loading} type="submit">
                    Добавить вопрос
                  </button>
                </form>

                <div className="questions">
                  {selectedQuiz.questions.map((question, index) => (
                    <article className="question-card" key={question.id}>
                      <div className="question-card-head">
                        <strong>
                          {index + 1}. {question.text}
                        </strong>
                        <button
                          className="danger"
                          type="button"
                          onClick={() => deleteQuestion(question.id)}
                          disabled={loading}
                        >
                          Удалить
                        </button>
                      </div>
                      {question.image_url && (
                        <img
                          className="question-image"
                          src={question.image_url}
                          alt="Изображение вопроса"
                        />
                      )}
                      <ul>
                        {question.options.map((option) => (
                          <li className={option.is_correct ? 'correct' : ''} key={option.id}>
                            {option.text}
                          </li>
                        ))}
                      </ul>
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <div className="empty-state">
                <h2>Выберите квиз</h2>
                <p>После выбора здесь появится конструктор вопросов.</p>
              </div>
            )}
          </section>
        </div>
      )}

      {renderHistory()}

      {status && <p className="toast">{status}</p>}
    </main>
  );
}
