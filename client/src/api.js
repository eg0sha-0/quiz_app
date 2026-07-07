const API_URL = 'http://localhost:4000/api';

export function getStoredSession() {
  const raw = localStorage.getItem('quiz_session');
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    localStorage.removeItem('quiz_session');
    return null;
  }
}

export function saveSession(session) {
  localStorage.setItem('quiz_session', JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem('quiz_session');
}

export async function apiRequest(path, { method = 'GET', body, token } = {}) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) return null;

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'Ошибка запроса к серверу');
  }

  return data;
}
