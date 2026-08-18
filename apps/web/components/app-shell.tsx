"use client";

import {
  Activity,
  BarChart3,
  Bot,
  CheckSquare,
  ChevronDown,
  Database,
  FileScan,
  Files,
  Gauge,
  LayoutDashboard,
  Menu,
  ReceiptText,
  Settings,
  ShieldCheck,
  Upload,
  WalletCards,
  X
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocale } from "../lib/locale";
import { clearSession, readSession, type StoredAuthSession } from "../lib/session";

type AppShellProps = {
  title: string;
  detail?: string;
  eyebrow?: string;
  actions?: ReactNode;
  children?: ReactNode;
};

type NavItem = {
  href: string;
  tr: string;
  en: string;
  permission?: string;
  icon: typeof LayoutDashboard;
};

const primaryNavigation: NavItem[] = [
  { href: "/dashboard", tr: "Genel bakış", en: "Overview", icon: LayoutDashboard },
  { href: "/documents/upload", tr: "Belgeler", en: "Documents", permission: "documents.read", icon: Files },
  { href: "/documents/ocr", tr: "OCR çalışma alanı", en: "OCR workspace", permission: "ocr.run", icon: FileScan },
  { href: "/review", tr: "İnceleme", en: "Review", permission: "ocr.review", icon: CheckSquare },
  { href: "/expenses", tr: "Giderler", en: "Expenses", permission: "expenses.read", icon: ReceiptText },
  { href: "/approvals", tr: "Onaylar", en: "Approvals", permission: "expenses.approve", icon: ShieldCheck },
  { href: "/budgets", tr: "Bütçeler", en: "Budgets", permission: "expenses.read", icon: WalletCards },
  { href: "/reports", tr: "Raporlar", en: "Reports", permission: "reports.export", icon: BarChart3 }
];

const managementNavigation: NavItem[] = [
  { href: "/models", tr: "OCR modelleri", en: "OCR models", permission: "models.train", icon: Bot },
  { href: "/settings", tr: "Ayarlar", en: "Settings", icon: Settings }
];

const adminNavigation: NavItem[] = [
  { href: "/admin/health", tr: "Sistem sağlığı", en: "System health", permission: "admin.health.read", icon: Activity },
  { href: "/admin/jobs", tr: "İş kuyruğu", en: "Job queue", permission: "admin.jobs.read", icon: Gauge },
  { href: "/admin/events", tr: "Olay teslimi", en: "Event delivery", permission: "admin.events.read", icon: Upload },
  { href: "/admin/cache", tr: "Önbellek", en: "Cache", permission: "admin.cache.read", icon: Database },
  { href: "/admin/audit", tr: "Denetim kayıtları", en: "Audit logs", permission: "admin.audit.read", icon: ShieldCheck }
];

export function AppShell({ title, detail, eyebrow, actions, children }: AppShellProps) {
  const pathname = usePathname();
  const { locale } = useLocale();
  const [session, setSession] = useState<StoredAuthSession | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(pathname.startsWith("/admin"));
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null);
  const mobileDrawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setSession(readSession());
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    mobileCloseButtonRef.current?.focus();
    const handleDrawerKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const drawer = mobileDrawerRef.current;
      if (!drawer) return;
      const focusable = Array.from(
        drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleDrawerKeyboard);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleDrawerKeyboard);
      mobileMenuButtonRef.current?.focus();
    };
  }, [mobileOpen]);

  const permissions = useMemo(() => new Set(session?.permissions ?? []), [session]);
  const visible = (items: NavItem[]) => items.filter((item) => !item.permission || permissions.has(item.permission));
  const localized = (href: string) => `${href}?lang=${locale}`;

  const navigation = (scope: "desktop" | "mobile") => (
    <>
      <div className="app-brand">
        <div className="app-brand-mark" aria-hidden="true">SL</div>
        <div>
          <div className="app-brand-name">SpendLens AI</div>
          <div className="app-brand-caption">{locale === "tr" ? "Gider operasyonları" : "Expense operations"}</div>
        </div>
      </div>

      <nav className="app-nav" aria-label={locale === "tr" ? "Ana gezinme" : "Primary navigation"}>
        <NavLinks items={visible(primaryNavigation)} locale={locale} pathname={pathname} localized={localized} />
        <div className="app-nav-label">{locale === "tr" ? "Yönetim" : "Management"}</div>
        <NavLinks items={visible(managementNavigation)} locale={locale} pathname={pathname} localized={localized} />
        {visible(adminNavigation).length > 0 ? (
          <div className="app-nav-admin">
            <button className="app-nav-disclosure" type="button" aria-expanded={adminOpen} aria-controls={`app-admin-navigation-${scope}`} onClick={() => setAdminOpen((open) => !open)}>
              <span>{locale === "tr" ? "Sistem yönetimi" : "System administration"}</span>
              <ChevronDown className={adminOpen ? "rotate-180" : ""} size={16} aria-hidden="true" />
            </button>
            {adminOpen ? <div id={`app-admin-navigation-${scope}`}><NavLinks items={visible(adminNavigation)} locale={locale} pathname={pathname} localized={localized} /></div> : null}
          </div>
        ) : null}
      </nav>

      <div className="app-account">
        <div className="app-account-avatar" aria-hidden="true">{initials(session?.user.displayName)}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{session?.user.displayName ?? (locale === "tr" ? "Yerel kullanıcı" : "Local user")}</div>
          <div className="truncate text-xs text-[var(--text-secondary)]">{session?.tenant.name ?? "SpendLens AI"}</div>
        </div>
        {session ? (
          <button
            type="button"
            className="app-signout"
            onClick={() => {
              clearSession();
              window.location.href = "/login";
            }}
          >
            {locale === "tr" ? "Çıkış" : "Sign out"}
          </button>
        ) : null}
      </div>
    </>
  );

  return (
    <div className="app-frame">
      <aside className="app-sidebar">{navigation("desktop")}</aside>
      <header className="app-mobile-header">
        <Link href={localized("/dashboard")} className="app-mobile-brand">SpendLens AI</Link>
        <button ref={mobileMenuButtonRef} type="button" className="app-icon-button" aria-label={locale === "tr" ? "Menüyü aç" : "Open menu"} aria-expanded={mobileOpen} aria-controls="app-mobile-navigation" onClick={() => setMobileOpen(true)}>
          <Menu size={22} aria-hidden="true" />
        </button>
      </header>
      {mobileOpen ? (
        <div className="app-mobile-overlay" role="presentation" onClick={() => setMobileOpen(false)}>
          <aside ref={mobileDrawerRef} id="app-mobile-navigation" className="app-mobile-drawer" role="dialog" aria-modal="true" aria-label={locale === "tr" ? "Mobil gezinme" : "Mobile navigation"} onClick={(event) => event.stopPropagation()}>
            <button ref={mobileCloseButtonRef} type="button" className="app-mobile-close" aria-label={locale === "tr" ? "Menüyü kapat" : "Close menu"} onClick={() => setMobileOpen(false)}>
              <X size={22} aria-hidden="true" />
            </button>
            {navigation("mobile")}
          </aside>
        </div>
      ) : null}
      <main className="app-main">
        <div className="app-content">
          <header className="app-page-header">
            <div className="min-w-0">
              {eyebrow ? <p className="app-page-eyebrow">{eyebrow}</p> : null}
              <h1 className="app-page-title">{title}</h1>
              {detail ? <p className="app-page-detail">{detail}</p> : null}
            </div>
            {actions ? <div className="app-page-actions">{actions}</div> : null}
          </header>
          {children}
        </div>
      </main>
    </div>
  );
}

function NavLinks({ items, locale, pathname, localized }: { items: NavItem[]; locale: "tr" | "en"; pathname: string; localized: (href: string) => string }) {
  return (
    <div className="app-nav-list">
      {items.map((item) => {
        const Icon = item.icon;
        const active = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`));
        return (
          <Link key={item.href} href={localized(item.href)} className={active ? "app-nav-link app-nav-link-active" : "app-nav-link"} aria-current={active ? "page" : undefined}>
            <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
            <span>{item[locale]}</span>
          </Link>
        );
      })}
    </div>
  );
}

function initials(name: string | undefined): string {
  if (!name) return "SL";
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase("tr-TR")).join("") || "SL";
}
