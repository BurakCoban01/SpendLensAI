"use client";

import Link from "next/link";
import { AuthShell } from "../../components/auth-shell";
import { LoginForm } from "../../components/auth-forms";
import { useLocale } from "../../lib/locale";

const copy = {
  tr: {
    title: "Giriş yap",
    subtitle: "Var olan yerel çalışma alanınızı çalışma alanına özel yetki ve oturum takibiyle açın.",
    register: "Kayıt ol",
    prompt: "Çalışma alanınız yok mu?"
  },
  en: {
    title: "Sign in",
    subtitle: "Open your local workspace with workspace-scoped permissions and session tracking.",
    register: "Register",
    prompt: "No workspace yet?"
  }
} as const;

export default function LoginPage() {
  const { locale } = useLocale();
  const text = copy[locale];

  return (
    <AuthShell title={text.title} subtitle={text.subtitle}>
      <LoginForm />
      <p className="mt-6 text-sm text-steel">
        {text.prompt}{" "}
        <Link className="font-semibold text-ink underline underline-offset-4" href="/register">
          {text.register}
        </Link>
      </p>
    </AuthShell>
  );
}
