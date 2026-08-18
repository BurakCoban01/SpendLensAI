"use client";

import Link from "next/link";
import { AuthShell } from "../../components/auth-shell";
import { RegisterForm } from "../../components/auth-forms";
import { useLocale } from "../../lib/locale";

const copy = {
  tr: {
    title: "Çalışma alanı oluştur",
    subtitle: "API kimlik katmanıyla yerel çalışma alanını, sahip hesabını ve finans ortamını birlikte başlatın.",
    login: "Giriş yap",
    prompt: "Zaten hesabınız var mı?"
  },
  en: {
    title: "Create workspace",
    subtitle: "Start a local workspace, owner account and finance environment together with the API identity layer.",
    login: "Sign in",
    prompt: "Already have an account?"
  }
} as const;

export default function RegisterPage() {
  const { locale } = useLocale();
  const text = copy[locale];

  return (
    <AuthShell title={text.title} subtitle={text.subtitle}>
      <RegisterForm />
      <p className="mt-6 text-sm text-steel">
        {text.prompt}{" "}
        <Link className="font-semibold text-ink underline underline-offset-4" href="/login">
          {text.login}
        </Link>
      </p>
    </AuthShell>
  );
}
