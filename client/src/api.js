import { io } from 'socket.io-client';

const TOKEN_KEY = 'cnis.token';
const USER_KEY = 'cnis.user';

export function getSession() {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const user = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    return token && user ? { token, user } : null;
  } catch {
    return null;
  }
}

export function saveSession(s) {
  try {
    if (s) { localStorage.setItem(TOKEN_KEY, s.token); localStorage.setItem(USER_KEY, JSON.stringify(s.user)); }
    else { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }
  } catch { /* storage unavailable */ }
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(path, { method = 'GET', body } = {}) {
  const s = getSession();
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(s ? { authorization: `Bearer ${s.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') {
    saveSession(null);
    window.location.assign('/login');
  }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data;
}

let socket = null;
export function getSocket() {
  const s = getSession();
  if (!s) return null;
  if (!socket) socket = io({ auth: { token: s.token } });
  return socket;
}
export function closeSocket() { socket?.close(); socket = null; }

export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const fmtShort = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—');
export const age = (dob) => Math.floor((Date.now() - new Date(dob)) / (365.25 * 864e5));
export const pct = (x) => (x == null ? '—' : `${Math.round(x * 1000) / 10}%`);
