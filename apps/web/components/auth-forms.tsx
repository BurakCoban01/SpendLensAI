"use client";

import { FormEvent, useState } from "react";
import { apiRequest, type AuthResponse } from "../lib/api";
import { saveSession } from "../lib/session";
import { useLocale } from "../lib/locale";

type FormState = "idle" | "submitting" | "error";

const copy = {
  tr: {
    login: {
      tenantSlug: "Çalışma alanı kısa adı",
      email: "E-posta",
      password: "Parola",
      required: "Bu alan zorunludur.",
      invalidEmail: "Geçerli bir e-posta adresi girin.",
      submit: "Giriş yap",
      submitting: "Giriş yapılıyor..."
    },
    register: {
      tenantName: "Çalışma alanı adı",
      tenantSlug: "Çalışma alanı kısa adı",
      workspaceName: "Çalışma alanı",
      displayName: "Görünen ad",
      email: "E-posta",
      password: "Parola",
      passwordHint: "En az 12 karakter kullanın.",
      required: "Bu alan zorunludur.",
      invalidEmail: "Geçerli bir e-posta adresi girin.",
      passwordTooShort: "Parola en az 12 karakter olmalıdır.",
      submit: "Çalışma alanı oluştur",
      submitting: "Çalışma alanı oluşturuluyor..."
    },
    errors: {
      NETWORK_ERROR: "Uygulama hizmetine ulaşılamadı. Yerel uygulamayı yeniden başlatıp tekrar deneyin.",
      REQUEST_FAILED: "İstek tamamlanamadı. Bağlantınızı kontrol edip tekrar deneyin.",
      LOGIN_FAILED: "Giriş yapılamadı. Çalışma alanı kısa adı, e-posta ve parolayı kontrol edin.",
      REGISTER_FAILED: "Kayıt oluşturulamadı. Girilen alanları ve parola gereksinimini kontrol edin.",
      SESSION_FAILED: "Oturum doğrulanamadı. Lütfen yeniden giriş yapın."
    }
  },
  en: {
    login: {
      tenantSlug: "Workspace slug",
      email: "Email",
      password: "Password",
      required: "This field is required.",
      invalidEmail: "Enter a valid email address.",
      submit: "Sign in",
      submitting: "Signing in..."
    },
    register: {
      tenantName: "Workspace name",
      tenantSlug: "Workspace slug",
      workspaceName: "Workspace",
      displayName: "Display name",
      email: "Email",
      password: "Password",
      passwordHint: "Use at least 12 characters.",
      required: "This field is required.",
      invalidEmail: "Enter a valid email address.",
      passwordTooShort: "Password must contain at least 12 characters.",
      submit: "Create workspace",
      submitting: "Creating workspace..."
    },
    errors: {
      NETWORK_ERROR: "The application service could not be reached. Restart the local application and try again.",
      REQUEST_FAILED: "The request could not be completed. Check your connection and try again.",
      LOGIN_FAILED: "Sign-in failed. Check the workspace slug, email and password.",
      REGISTER_FAILED: "Registration failed. Check the entered fields and password requirements.",
      SESSION_FAILED: "Session could not be verified. Please sign in again."
    }
  }
} as const;

const authErrorMessages: Record<"tr" | "en", Record<string, string>> = {
  tr: copy.tr.errors,
  en: copy.en.errors
};

export function LoginForm() {
  const { locale } = useLocale();
  const text = copy[locale].login;
  const [state, setState] = useState<FormState>("idle");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("submitting");
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const session = await apiRequest<AuthResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          tenantSlug: formValue(form, "tenantSlug"),
          email: formValue(form, "email"),
          password: formValue(form, "password")
        })
      });
      saveSession(session);
      location.href = `/dashboard?lang=${encodeURIComponent(locale)}`;
    } catch (caught) {
      setState("error");
      setError(formatAuthError(locale, caught, "LOGIN_FAILED"));
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5" aria-busy={state === "submitting"}>
      <Field label={text.tenantSlug} name="tenantSlug" defaultValue="demo" requiredMessage={text.required} />
      <Field label={text.email} name="email" type="email" autoComplete="email" requiredMessage={text.required} invalidEmailMessage={text.invalidEmail} />
      <Field label={text.password} name="password" type="password" autoComplete="current-password" minLength={1} requiredMessage={text.required} />
      <div aria-live="polite" aria-atomic="true">{error ? <p className="product-alert product-alert-danger" role="alert">{error}</p> : null}</div>
      <button className="product-button-primary w-full" disabled={state === "submitting"}>
        {state === "submitting" ? text.submitting : text.submit}
      </button>
    </form>
  );
}

export function RegisterForm() {
  const { locale } = useLocale();
  const text = copy[locale].register;
  const [state, setState] = useState<FormState>("idle");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("submitting");
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const session = await apiRequest<AuthResponse>("/auth/register", {
        method: "POST",
        body: JSON.stringify({
          tenantName: formValue(form, "tenantName"),
          tenantSlug: formValue(form, "tenantSlug"),
          workspaceName: formValue(form, "workspaceName"),
          email: formValue(form, "email"),
          displayName: formValue(form, "displayName"),
          password: formValue(form, "password")
        })
      });
      saveSession(session);
      location.href = `/dashboard?lang=${encodeURIComponent(locale)}`;
    } catch (caught) {
      setState("error");
      setError(formatAuthError(locale, caught, "REGISTER_FAILED"));
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5" aria-busy={state === "submitting"}>
      <Field label={text.tenantName} name="tenantName" requiredMessage={text.required} />
      <Field label={text.tenantSlug} name="tenantSlug" requiredMessage={text.required} />
      <Field label={text.workspaceName} name="workspaceName" defaultValue={locale === "tr" ? "Finans" : "Finance"} requiredMessage={text.required} />
      <Field label={text.displayName} name="displayName" autoComplete="name" requiredMessage={text.required} />
      <Field label={text.email} name="email" type="email" autoComplete="email" requiredMessage={text.required} invalidEmailMessage={text.invalidEmail} />
      <Field
        label={text.password}
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={12}
        hint={text.passwordHint}
        requiredMessage={text.required}
        tooShortMessage={text.passwordTooShort}
      />
      <div aria-live="polite" aria-atomic="true">{error ? <p className="product-alert product-alert-danger" role="alert">{error}</p> : null}</div>
      <button className="product-button-primary w-full" disabled={state === "submitting"}>
        {state === "submitting" ? text.submitting : text.submit}
      </button>
    </form>
  );
}

function Field({
  label,
  name,
  type = "text",
  defaultValue,
  autoComplete,
  minLength,
  hint,
  requiredMessage,
  invalidEmailMessage,
  tooShortMessage
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  autoComplete?: string;
  minLength?: number;
  hint?: string;
  requiredMessage: string;
  invalidEmailMessage?: string;
  tooShortMessage?: string;
}) {
  const [validationError, setValidationError] = useState("");
  const inputId = `auth-${name}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  function validate(input: HTMLInputElement) {
    if (input.validity.valueMissing) setValidationError(requiredMessage);
    else if (input.validity.typeMismatch) setValidationError(invalidEmailMessage ?? requiredMessage);
    else if (input.validity.tooShort) setValidationError(tooShortMessage ?? requiredMessage);
    else setValidationError("");
  }

  return (
    <label className="block text-sm font-medium" htmlFor={inputId}>
      <span>{label}</span>
      <input
        id={inputId}
        name={name}
        type={type}
        required
        defaultValue={defaultValue}
        autoComplete={autoComplete}
        minLength={minLength}
        aria-describedby={[hint ? hintId : null, validationError ? errorId : null].filter(Boolean).join(" ") || undefined}
        aria-invalid={validationError ? "true" : undefined}
        onBlur={(event) => validate(event.currentTarget)}
        onInput={(event) => {
          if (validationError) validate(event.currentTarget);
        }}
        onInvalid={(event) => validate(event.currentTarget)}
        className="product-field mt-2"
      />
      {hint ? <span id={hintId} className="mt-1 block text-xs font-normal text-[var(--text-secondary)]">{hint}</span> : null}
      {validationError ? <span id={errorId} className="mt-1 block text-xs font-semibold text-[var(--danger)]" role="alert">{validationError}</span> : null}
    </label>
  );
}

function formValue(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

function formatAuthError(locale: "tr" | "en", caught: unknown, fallback: string): string {
  const message = caught instanceof Error ? caught.message : fallback;
  return authErrorMessages[locale][message] ?? authErrorMessages[locale][fallback] ?? message;
}
