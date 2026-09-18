import { el } from '../dom.js';

export function createAuthGate({ overlay, login }) {
  const password = el('input', {
    type: 'password',
    class: 'control control--text',
    id: 'password',
    name: 'password',
    autocomplete: 'current-password',
    enterkeyhint: 'go',
  });

  const message = el('p', { class: 'login__message' });
  message.hidden = true;

  const submit = el('button', { type: 'submit', class: 'btn btn--primary' }, 'Log in');
  const form = el('form', { class: 'login' }, [
    el('h1', { class: 'login__title' }, 'Wardrobe'),
    el('label', { class: 'field__label', for: 'password' }, 'Password'),
    password,
    message,
    submit,
  ]);

  overlay.append(form);
  let waiting = [];

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;

    message.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Checking';
    try {
      await login(password.value);
      password.value = '';
      overlay.hidden = true;
      // Every request that hit the same 401 waits here and retries itself once
      // the cookie is back.
      const resume = waiting;
      waiting = [];
      for (const done of resume) done();
    } catch (error) {
      message.textContent = error.message;
      message.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = 'Log in';
    }
  });

  return {
    open() {
      overlay.hidden = false;
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
}
