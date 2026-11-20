
const form = document.querySelector('#auth-form');
const title = document.querySelector('#form-title');
const subtitle = document.querySelector('#form-subtitle');
const nameGroup = document.querySelector('#name-group');
const nameInput = document.querySelector('#name');
const emailInput = document.querySelector('#email');
const passwordInput = document.querySelector('#password');
const submitBtn = document.querySelector('#submit-btn');
const switchBtn = document.querySelector('#switch-mode');
const switchMessage = document.querySelector('#switch-message');
const errorMessage = document.querySelector('#auth-error');

let isSignUp = false;

// Switch between login and registration forms.
function updateForm() {
  form.reset();
  hideError();

  nameGroup.hidden = !isSignUp;
  nameInput.required = isSignUp;

  title.textContent = isSignUp
    ? 'Create your account'
    : 'Welcome back';

  subtitle.textContent = isSignUp
    ? 'Start organizing your coursework and study schedule.'
    : 'Enter your details to sign in to your account.';

  submitBtn.textContent = isSignUp
    ? 'Create account'
    : 'Sign in';

  switchMessage.textContent = isSignUp
    ? 'Already have an account?'
    : "Don't have an account?";

  switchBtn.textContent = isSignUp
    ? 'Sign in'
    : 'Create an account';

  passwordInput.autocomplete = isSignUp
    ? 'new-password'
    : 'current-password';
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

function hideError() {
  errorMessage.textContent = '';
  errorMessage.hidden = true;
}

// Handle switching between the two forms.
switchBtn.addEventListener('click', () => {
  isSignUp = !isSignUp;
  updateForm();
  emailInput.focus();
});

// Send login or registration details to the server.
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideError();

  const name = nameInput.value.trim();
  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;

  if (isSignUp && !name) {
    showError('Please enter your full name.');
    return;
  }

  if (password.length < 8) {
    showError('Password must be at least 8 characters.');
    return;
  }

  const endpoint = isSignUp
    ? '/api/auth/register'
    : '/api/auth/login';

  const userData = isSignUp
    ? { name, email, password }
    : { email, password };

  submitBtn.disabled = true;
  switchBtn.disabled = true;
  submitBtn.textContent = isSignUp
    ? 'Creating account...'
    : 'Signing in...';

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'same-origin',
      body: JSON.stringify(userData)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || 'Something went wrong. Please try again.'
      );
    }

    // The server creates the session before redirecting.
    window.location.replace('/');

  } catch (error) {
    showError(error.message);
  } finally {
    submitBtn.disabled = false;
    switchBtn.disabled = false;

    submitBtn.textContent = isSignUp
      ? 'Create account'
      : 'Sign in';
  }
});

updateForm();
