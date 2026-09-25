import { useState, useSyncExternalStore } from 'react';
import { authGate } from '../lib/authGate.js';
import { api } from '../lib/queries.js';
import { errorMessage } from '../lib/write.js';

export function AuthOverlay() {
  const open = useSyncExternalStore(authGate.subscribe, authGate.isOpen);
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (checking) return;

    setMessage(null);
    setChecking(true);
    try {
      await api.login(password);
      setPassword('');
      // Cleared here as well as on the way in. The gate can only close on a
      // success today, so nothing stale can survive it, but that is a fact
      // about one caller rather than about this form.
      setMessage(null);
      authGate.close();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="overlay" hidden={!open}>
      {open && (
        <form className="login" onSubmit={submit}>
          <h1 className="login__title">Wardrobe</h1>
          <label className="field__label" htmlFor="password">
            Password
          </label>
          <input
            className="control control--text"
            type="password"
            id="password"
            name="password"
            autoComplete="current-password"
            enterKeyHint="go"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p className="login__message" hidden={message === null}>
            {message}
          </p>
          <button className="btn btn--primary" type="submit" disabled={checking}>
            {checking ? 'Checking' : 'Log in'}
          </button>
        </form>
      )}
    </div>
  );
}
