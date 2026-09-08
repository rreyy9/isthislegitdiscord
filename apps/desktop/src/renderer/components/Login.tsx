import { useEffect, useState } from 'react';
import { api, getServerUrl, setServerUrl, setToken } from '../api';

export function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [server, setServer] = useState(getServerUrl());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setServer(getServerUrl());
  }, []);

  async function submit() {
    setError('');
    setBusy(true);
    try {
      await setServerUrl(server);
      const res =
        mode === 'login'
          ? await api.login(username.trim(), password)
          : await api.register({
              username: username.trim(),
              password,
              inviteCode: inviteCode.trim(),
              displayName: displayName.trim() || undefined,
            });
      if (!res.token) throw new Error('No token returned.');
      await setToken(res.token);
      onDone();
    } catch (e: any) {
      setError(e.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    username.trim().length >= 2 &&
    password.length >= (mode === 'register' ? 8 : 1) &&
    (mode === 'login' || inviteCode.trim().length >= 4);

  return (
    <div className="login-wrap">
      <div className="login">
        <img className="mark" src="./icon.png" alt="" width={56} height={56} />
        <h1>isthislegit</h1>
        <p className="sub">
          {mode === 'login' ? 'Sign in to your server.' : 'Create an account with an invite code.'}
        </p>

        <label>Username</label>
        <input
          value={username}
          autoFocus
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && canSubmit && submit()}
        />

        {mode === 'register' && (
          <>
            <label>Display name (optional)</label>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </>
        )}

        <label>Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && canSubmit && submit()}
        />

        {mode === 'register' && (
          <>
            <label>Invite code</label>
            <input
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && canSubmit && submit()}
            />
          </>
        )}

        <div className="err">{error}</div>

        <button className="primary" disabled={!canSubmit || busy} onClick={submit}>
          {busy ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        <div className="toggle">
          {mode === 'login' ? (
            <>Have an invite? <a onClick={() => { setMode('register'); setError(''); }}>Register</a></>
          ) : (
            <>Already have an account? <a onClick={() => { setMode('login'); setError(''); }}>Sign in</a></>
          )}
        </div>

        <div className="server-row">
          <label>Server address</label>
          <input value={server} onChange={(e) => setServer(e.target.value)} />
        </div>
      </div>
    </div>
  );
}
