import { formatProfileDate } from "../lib/profileGate";

interface ProfileSectionProps {
  buttonText: string;
  appCount: number;
  websiteCount: number;
  profileUpdatedAt: string;
  childName: string;
  avatar?: string;
  profileUrl?: string;
}

export function ProfileSection({
  buttonText,
  appCount,
  websiteCount,
  profileUpdatedAt,
  childName,
  avatar,
  profileUrl = "/profile.mobileconfig",
}: ProfileSectionProps) {
  return (
    <section className="profile-section flex items-center gap-4 px-5 py-4 border border-border rounded-xl bg-surface backdrop-blur-md shadow-card">
      <div className="profile-icon flex items-center justify-center w-14 h-14 rounded-2xl text-white" aria-hidden="true">
        {avatar ? (
          <span className="text-2xl leading-none">{avatar}</span>
        ) : (
          <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
            <rect x="7" y="2" width="18" height="28" rx="4" stroke="currentColor" strokeWidth="2" />
            <circle cx="16" cy="24" r="1.5" fill="currentColor" />
          </svg>
        )}
      </div>

      <div className="profile-copy flex-1 min-w-0">
        <h2 className="m-0 text-[1.1rem] font-extrabold">{childName}&apos;s profile</h2>
        <p className="mt-0.5 mb-0 text-muted text-sm">
          {appCount} apps{websiteCount > 0 && ` · ${websiteCount} Home Screen websites`} · updated{" "}
          <time dateTime={profileUpdatedAt}>{formatProfileDate(profileUpdatedAt)}</time>
        </p>
      </div>

      <a
        className="profile-button inline-flex items-center justify-center shrink-0 min-h-12 px-6 rounded-md text-white no-underline text-base font-extrabold whitespace-nowrap shadow-btn transition-transform duration-150 ease-out hover:-translate-y-px hover:shadow-btn-hover active:translate-y-0"
        href={profileUrl}
      >
        {buttonText}
      </a>
    </section>
  );
}
