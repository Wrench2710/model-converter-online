import axios from "axios";
import { FormEvent, useEffect, useState } from "react";
import { AlertCircle, Box, Check, Eye, EyeOff, Languages, LoaderCircle, Monitor, RefreshCw } from "lucide-react";
import { Captcha, getCaptcha, login, register, User } from "./api";

type Locale = "en" | "zh";
type Errors = Partial<Record<"username" | "password" | "confirmPassword" | "captcha" | "form", string[]>>;
const messages = {
  zh: {
    studio: "私有模型工作区", login: "登录", register: "创建账户",
    intro: "登录后访问你的模型、转换任务与文件。",
    sessionExpired: "登录已过期，请重新登录。待确认的模型和贴图已保留。",
    email: "邮箱", password: "密码", confirmPassword: "确认密码", captcha: "图形验证码",
    captchaAlt: "注册验证码图片", refreshCaptcha: "更换验证码", captchaHint: "6 位字符，不区分大小写，5 分钟内有效。",
    passwordHint: "至少 12 位，包含大写字母、小写字母、数字、符号中的至少三类。",
    emailInvalid: "请输入有效的邮箱地址。", passwordRequired: "请输入密码。",
    passwordShort: "密码至少需要 12 位。", passwordVariety: "请使用大写字母、小写字母、数字、符号中的至少三类。",
    passwordCommon: "这个密码太常见，请换一个更难猜的密码。",
    passwordSimilar: "密码与邮箱过于相似，请更换密码。", passwordNumeric: "密码不能全部为数字。",
    passwordLong: "密码不能超过 256 位。", duplicate: "这个邮箱已经注册，可以直接登录。",
    mismatch: "两次输入的密码不一致。", captchaRequired: "请输入图形验证码。",
    captchaInvalid: "验证码错误或已过期，请输入新的验证码。",
    credentials: "邮箱或密码不正确，请重试。", network: "无法连接服务器，请检查网络后重试。",
    unavailable: "服务暂时不可用，请稍后重试。", throttled: "操作过于频繁，请稍后再试。",
    submitting: "正在提交…", needAccount: "还没有账户？", haveAccount: "已有账户？",
    showPassword: "显示密码", hidePassword: "隐藏密码", loadingCaptcha: "正在加载验证码", language: "语言",
  },
  en: {
    studio: "Private model workspace", login: "Sign in", register: "Create account",
    intro: "Access your models, conversions, and source files.",
    sessionExpired: "Your session has expired. Sign in again. Pending models and textures have been kept.",
    email: "Email", password: "Password", confirmPassword: "Confirm password", captcha: "Verification code",
    captchaAlt: "Registration verification image", refreshCaptcha: "Refresh verification code",
    captchaHint: "6 characters, case insensitive. Valid for 5 minutes.",
    passwordHint: "12+ characters with at least three of uppercase, lowercase, numbers, and symbols.",
    emailInvalid: "Enter a valid email address.", passwordRequired: "Enter your password.",
    passwordShort: "Use at least 12 characters.", passwordVariety: "Use at least three of uppercase, lowercase, numbers, and symbols.",
    passwordCommon: "This password is too common. Choose a less predictable one.",
    passwordSimilar: "This password is too similar to your email.", passwordNumeric: "Your password cannot be entirely numeric.",
    passwordLong: "Use no more than 256 characters.", duplicate: "This email is already registered. You can sign in.",
    mismatch: "The passwords do not match.", captchaRequired: "Enter the verification code.",
    captchaInvalid: "The code is incorrect or expired. Enter the new code.",
    credentials: "The email or password is incorrect.", network: "Cannot connect to the server. Check your connection and retry.",
    unavailable: "The service is temporarily unavailable. Please try again later.", throttled: "Too many attempts. Please try again later.",
    submitting: "Submitting…", needAccount: "Need an account?", haveAccount: "Already have an account?",
    showPassword: "Show password", hidePassword: "Hide password", loadingCaptcha: "Loading verification code", language: "Language",
  },
};

function passwordKinds(value: string) {
  return [/\p{Ll}/u, /\p{Lu}/u, /\p{N}/u, /[^\p{L}\p{N}\s]/u].filter((pattern) => pattern.test(value)).length;
}

export default function AuthScreen({ locale, onLocaleChange, onAuthenticated, sessionExpired = false, onGuest }: {
  locale: Locale; onLocaleChange: (locale: Locale) => void; onAuthenticated: (user: User) => void; sessionExpired?: boolean; onGuest?: () => void;
}) {
  const t = messages[locale];
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [captcha, setCaptcha] = useState<Captcha | null>(null);
  const [captchaInput, setCaptchaInput] = useState("");
  const [captchaVersion, setCaptchaVersion] = useState(0);
  const [loadingCaptcha, setLoadingCaptcha] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  const creating = mode === "register";

  useEffect(() => {
    if (!creating) return;
    const controller = new AbortController();
    setLoadingCaptcha(true);
    setCaptcha(null);
    setCaptchaInput("");
    getCaptcha(controller.signal).then((value) => {
      if (!controller.signal.aborted) setCaptcha(value);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setErrors((current) => ({ ...current, form: [
          axios.isAxiosError(error) && error.response?.status === 429 ? t.throttled : t.unavailable,
        ] }));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingCaptcha(false);
    });
    return () => controller.abort();
  }, [creating, captchaVersion, t.throttled, t.unavailable]);

  const errorMessage = (field: string, code: string, fallback: string) => {
    if (field === "captcha" || field === "captcha_id") return code === "required" ? t.captchaRequired : t.captchaInvalid;
    if (field === "username") return code === "unique" ? t.duplicate : t.emailInvalid;
    const passwords: Record<string, string> = {
      password_too_short: t.passwordShort, password_too_common: t.passwordCommon,
      password_too_similar: t.passwordSimilar, password_entirely_numeric: t.passwordNumeric,
      password_variety: t.passwordVariety, max_length: t.passwordLong, required: t.passwordRequired,
    };
    return passwords[code] ?? fallback;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const next: Errors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.username = [t.emailInvalid];
    if (!password) next.password = [t.passwordRequired];
    if (creating) {
      const passwordErrors = [];
      if (password.length < 12) passwordErrors.push(t.passwordShort);
      if (passwordKinds(password) < 3) passwordErrors.push(t.passwordVariety);
      if (passwordErrors.length) next.password = passwordErrors;
      if (confirmation !== password) next.confirmPassword = [t.mismatch];
      if (!captchaInput.trim() || !captcha) next.captcha = [t.captchaRequired];
    }
    setErrors(next);
    if (Object.keys(next).length) return;
    setSubmitting(true);
    try {
      const username = email.trim().toLowerCase();
      const user = creating
        ? await register(username, password, captcha!.id, captchaInput.trim())
        : await login(username, password);
      onAuthenticated(user);
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        const response = error.response;
        if (!response) setErrors({ form: [t.network] });
        else if (response.status === 429) setErrors({ form: [t.throttled] });
        else if (response.data?.errors) {
          const fields: Errors = {};
          for (const [field, issues] of Object.entries(response.data.errors)) {
            const key = field === "captcha_id" ? "captcha" : field;
            const values = Array.isArray(issues) ? issues : [issues];
            fields[key as keyof Errors] = values.map((issue) => errorMessage(field, issue.code, issue.message));
          }
          setErrors(fields);
        } else setErrors({ form: [response.status >= 500 ? t.unavailable : t.credentials] });
      } else setErrors({ form: [t.unavailable] });
      if (creating) setCaptchaVersion((version) => version + 1);
    } finally {
      setSubmitting(false);
    }
  };

  const fieldErrors = (field: keyof Errors) => errors[field]?.length
    ? <div id={`${field}-error`} className="field-errors" role="alert">{errors[field]?.map((message) => <p key={message}><AlertCircle size={14} />{message}</p>)}</div>
    : null;

  return <main className="auth-shell">
    <section className="auth-panel" aria-labelledby="auth-heading">
      <div className="auth-header">
        <div className="brand auth-brand"><div className="brand-mark"><Box size={19} /></div><div><strong>Model Desk</strong><span>{t.studio}</span></div></div>
        <div className="language-switch" role="group" aria-label={t.language}>
          <Languages size={14} />
          <button type="button" className={locale === "en" ? "active" : ""} aria-pressed={locale === "en"} onClick={() => { setErrors({}); onLocaleChange("en"); }}>EN</button>
          <button type="button" className={locale === "zh" ? "active" : ""} aria-pressed={locale === "zh"} onClick={() => { setErrors({}); onLocaleChange("zh"); }}>中</button>
        </div>
      </div>
      <div className="auth-copy"><h1 id="auth-heading">{creating ? t.register : t.login}</h1><p role={sessionExpired ? "status" : undefined}>{sessionExpired ? t.sessionExpired : t.intro}</p></div>
      <form className="auth-form" noValidate onSubmit={submit}>
        <fieldset className="auth-fields" disabled={submitting}>
          <div className="auth-field">
            <label htmlFor="email">{t.email}</label>
            <input id="email" name="username" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false}
              placeholder="name@example.com" maxLength={150} required value={email} onChange={(e) => setEmail(e.target.value)}
              aria-invalid={Boolean(errors.username)} aria-describedby={errors.username ? "username-error" : undefined} />
            {fieldErrors("username")}
          </div>
          <div className="auth-field">
            <label htmlFor="password">{t.password}</label>
            <div className="password-input">
              <input id="password" name="password" type={showPassword ? "text" : "password"} required maxLength={256}
                minLength={creating ? 12 : undefined} autoComplete={creating ? "new-password" : "current-password"}
                value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={Boolean(errors.password)}
                aria-describedby={creating ? "password-hint password-error" : errors.password ? "password-error" : undefined} />
              <button type="button" className="icon-button" title={showPassword ? t.hidePassword : t.showPassword}
                aria-label={showPassword ? t.hidePassword : t.showPassword} aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
            {creating && <p id="password-hint" className="auth-hint">{t.passwordHint}</p>}
            {fieldErrors("password")}
          </div>
          {creating && <>
            <div className="auth-field">
              <label htmlFor="confirm-password">{t.confirmPassword}</label>
              <input id="confirm-password" name="confirmPassword" type={showPassword ? "text" : "password"} autoComplete="new-password"
                required maxLength={256} value={confirmation} onChange={(e) => setConfirmation(e.target.value)}
                aria-invalid={Boolean(errors.confirmPassword)} aria-describedby={errors.confirmPassword ? "confirmPassword-error" : undefined} />
              {fieldErrors("confirmPassword")}
            </div>
            <div className="auth-field">
              <label htmlFor="captcha">{t.captcha}</label>
              <div className="captcha-row">
                <div className="captcha-image" aria-busy={loadingCaptcha}>
                  {captcha ? <img src={captcha.image} alt={t.captchaAlt} width={200} height={64} /> : <LoaderCircle size={20} className="spinner" aria-label={t.loadingCaptcha} />}
                </div>
                <button type="button" className="icon-button captcha-refresh" disabled={loadingCaptcha} title={t.refreshCaptcha}
                  aria-label={t.refreshCaptcha} onClick={() => { setErrors({}); setCaptchaVersion((version) => version + 1); }}><RefreshCw size={17} /></button>
              </div>
              <input id="captcha" name="captcha" value={captchaInput} onChange={(e) => setCaptchaInput(e.target.value)}
                autoComplete="off" autoCapitalize="characters" spellCheck={false} required maxLength={6}
                aria-invalid={Boolean(errors.captcha)} aria-describedby="captcha-hint captcha-error" />
              <p id="captcha-hint" className="auth-hint">{t.captchaHint}</p>
              {fieldErrors("captcha")}
            </div>
          </>}
        </fieldset>
        {fieldErrors("form")}
        <button type="submit" className="primary-button wide auth-submit" disabled={submitting || (creating && (!captcha || loadingCaptcha))}>
          {submitting ? <LoaderCircle size={16} className="spinner" /> : creating ? <Check size={16} /> : null}
          {submitting ? t.submitting : creating ? t.register : t.login}
        </button>
      </form>
      <div className="auth-switch"><span>{creating ? t.haveAccount : t.needAccount}</span><button type="button" className="text-button" disabled={submitting}
        onClick={() => { setMode(creating ? "login" : "register"); setErrors({}); setPassword(""); setConfirmation(""); setShowPassword(false); }}>
        {creating ? t.login : t.register}
      </button></div>
      {onGuest && <button type="button" className="ghost-button wide guest-button" disabled={submitting} onClick={onGuest}>
        <Monitor size={16} />{locale === "zh" ? "游客登录" : "Continue as guest"}
      </button>}
    </section>
  </main>;
}
