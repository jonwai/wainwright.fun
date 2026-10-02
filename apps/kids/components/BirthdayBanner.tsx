import type { CSSProperties } from "react";
import type { BirthdayCelebration } from "../../../packages/shared/scripts/resolve";

export function BirthdayConfetti() {
  return (
    <div className="birthday-confetti" aria-hidden="true">
      {Array.from({ length: 14 }, (_, index) => (
        <span key={index} style={{ "--i": index } as CSSProperties} />
      ))}
    </div>
  );
}

export function BirthdayBanner({ birthday }: { birthday: BirthdayCelebration }) {
  return (
    <section
      className={`birthday-banner ${birthday.isToday ? "birthday-banner-today" : ""}`}
      aria-label={birthday.headline}
    >
      {birthday.isToday && <BirthdayConfetti />}
      <p className="birthday-headline">{birthday.headline}</p>
      {birthday.message && <p className="birthday-message">{birthday.message}</p>}
    </section>
  );
}
