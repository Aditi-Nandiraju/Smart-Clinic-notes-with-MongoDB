import React, { createContext, useContext, useState } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { getSession, saveSession, closeSocket } from './api.js';
import Login from './pages/Login.jsx';
import Today from './pages/Today.jsx';
import Patients from './pages/Patients.jsx';
import PatientDetail from './pages/PatientDetail.jsx';
import NewNote from './pages/NewNote.jsx';
import ReviewQueue from './pages/ReviewQueue.jsx';
import Review from './pages/Review.jsx';
import Search from './pages/Search.jsx';
import Assistant from './pages/Assistant.jsx';
import Analytics from './pages/Analytics.jsx';
import Audit from './pages/Audit.jsx';
import Vocabulary from './pages/Vocabulary.jsx';
import Models from './pages/Models.jsx';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

const NAV = [
  { to: '/', label: 'Today', roles: ['doctor', 'staff', 'admin'], end: true },
  { to: '/review', label: 'Review notes', roles: ['doctor', 'admin'] },
  { to: '/patients', label: 'Patients', roles: ['doctor', 'staff', 'admin'] },
  { to: '/search', label: 'Search notes', roles: ['doctor', 'admin'] },
  { to: '/assistant', label: 'Ask the records', roles: ['doctor', 'staff', 'admin'] },
  { to: '/analytics', label: 'Clinic analytics', roles: ['doctor', 'staff', 'admin'] },
  { to: '/vocabulary', label: 'Vocabulary', roles: ['doctor', 'admin'] },
  { to: '/models', label: 'Models', roles: ['doctor', 'staff', 'admin'] },
  { to: '/audit', label: 'Access log', roles: ['admin'] },
];

function Shell({ children }) {
  const { user, logout } = useAuth();
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">℞</span>
          <span>Clinical Notes</span>
        </div>
        <ul>
          {NAV.filter((n) => n.roles.includes(user.role)).map((n) => (
            <li key={n.to}><NavLink to={n.to} end={n.end}>{n.label}</NavLink></li>
          ))}
        </ul>
        <div className="who">
          <div className="who-name">{user.name}</div>
          <div className="who-role">{user.role === 'staff' ? 'Front desk' : user.role === 'admin' ? 'Administrator' : 'Doctor'}</div>
          <button type="button" className="link" onClick={logout}>Sign out</button>
        </div>
        <p className="synthetic-note">Demo data is synthetic. No real patients.</p>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}

function Guard({ roles, children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <Shell>{children}</Shell>;
}

export default function App() {
  const [session, setSession] = useState(getSession());
  const navigate = useNavigate();
  const auth = {
    user: session?.user ?? null,
    login: (s) => { saveSession(s); setSession(s); navigate('/'); },
    logout: () => { saveSession(null); closeSocket(); setSession(null); navigate('/login'); },
  };
  const D = ['doctor', 'admin'];
  return (
    <AuthCtx.Provider value={auth}>
      <Routes>
        <Route path="/login" element={session ? <Navigate to="/" replace /> : <Login />} />
        <Route path="/" element={<Guard><Today /></Guard>} />
        <Route path="/patients" element={<Guard><Patients /></Guard>} />
        <Route path="/patients/:id" element={<Guard><PatientDetail /></Guard>} />
        <Route path="/notes/new" element={<Guard roles={['doctor']}><NewNote /></Guard>} />
        <Route path="/review" element={<Guard roles={D}><ReviewQueue /></Guard>} />
        <Route path="/notes/:id" element={<Guard roles={D}><Review /></Guard>} />
        <Route path="/vocabulary" element={<Guard roles={D}><Vocabulary /></Guard>} />
        <Route path="/models" element={<Guard><Models /></Guard>} />
        <Route path="/search" element={<Guard roles={D}><Search /></Guard>} />
        <Route path="/assistant" element={<Guard><Assistant /></Guard>} />
        <Route path="/analytics" element={<Guard><Analytics /></Guard>} />
        <Route path="/audit" element={<Guard roles={['admin']}><Audit /></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthCtx.Provider>
  );
}
