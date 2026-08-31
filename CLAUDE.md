# Fit Life 2.0 — Build Guidelines for Claude Code

## Product
SaaS nutrition platform for Gulf families. Primary audience: Saudi/Gulf housewives 25-45. Unique angle: ONE subscription serves the whole household including the domestic worker, each in their own language. 7 languages supported. AI-powered personalized meal plans.

## Design Philosophy — READ EVERY TIME
We are NOT building a generic AI landing page. Before writing ANY component, the frontend-design skill must be active and you must apply its 4-dimension framework.

FORBIDDEN patterns (these are AI slop):
- Generic purple gradient on white backgrounds
- Floating glass-morphism cards
- Stock photos of women holding salads
- Center-aligned hero with two stacked buttons
- "Trusted by 10,000+ users" lines
- Inter or Geist font fallbacks (use ONLY Tajawal for Arabic, system-ui as last resort)
- 50/50 symmetric layouts
- Bouncy entrance animations on everything
- Gradient blobs as background decoration

REQUIRED patterns:
- Editorial layout (asymmetric where appropriate)
- Confident, warm, Gulf-native experience
- Arabic-first design (RTL is default, not afterthought)
- Mobile-first (70% of users on phones)
- Real product screenshots, not generic mockups
- Restrained motion (premium feel, not playful)

## Brand
- Primary: #4E2490 (deep purple)
- Accent Yellow: #F2BB16
- Accent Pink: #C5458F
- Lavender: #D9B0FC
- Surface: #EBEFF2 (NEVER pure white)
- Ink: #1A1023 (body text)

## Typography
- Font: Tajawal ONLY
- H1: 48-72px, weight 800, line-height 1.1
- H2: 36-48px, weight 700, line-height 1.2
- H3: 24-32px, weight 700
- Body: 16-18px, weight 400, line-height 1.7 (Arabic needs more line-height)
- NO letter-spacing on Arabic text

## Tone (Arabic Copy)
- Address the woman of the house: "أنتِ" — this is the DEFAULT voice, not the only one. Owner-directed copy on authenticated surfaces inflects for the answered الجنس via `genderPick(ownerSex)` (`apps/app/src/lib/copy/gender.ts`): pass `profiles.sex` for "you" copy, a member's sex for text about that member. Feminine is the fallback for null (question unanswered, legacy profile, logged-out visitor), so marketing/pre-signup copy stays feminine. NEVER dual-write ("اختاري/اختر") — pick one form per string pair.
- Warm but confident, NEVER saccharine
- NO exclamation marks in body copy
- Specific over generic
- Short sentences
- Questionnaire/onboarding copy: clear, warm فصحى (Coach Sara directive, 07/2026) — NOT عامية; feminine أنتِ address retained
- Marketing copy: Gulf norms acceptable (NOT Levantine or Egyptian phrasing)
- Numbers are powerful — lead with figures when possible
- NEVER translate from English; write Arabic-first

## Component Rules
- Sections in src/components/sections/
- Shadcn primitives in src/components/ui/
- React Server Components by default; "use client" only when needed
- Logical Tailwind classes only (start-*, end-*, ms-*, me-*) — NEVER physical (left-*, right-*, ml-*, mr-*)
- No boolean prop proliferation — use composition
- No inline styles

## Accessibility
- Yellow (#F2BB16) NEVER for body text on light bg
- Pink (#C5458F) only for headings 24px+ or large CTAs
- All interactive elements: min 44x44px tap target
- Meaningful Arabic alt text on all images
- Semantic HTML (section, header, nav, article)
- Focus rings visible and on-brand
- All animations respect prefers-reduced-motion

## Performance
- LCP target: under 1.5s
- All images via next/image with explicit width/height
- Above-the-fold: zero client-side JS where possible
- Lighthouse target: 95+ mobile

## Workflow Rule
Before building ANY section, you must:
1. Confirm frontend-design skill is loaded
2. Walk through the 4-dimension framework for that section
3. Wait for my approval of the design direction
4. Then write code

## Architecture Changes Since Original Handoff (May 24-26, 2026)

**PAYMENT IS CURRENTLY OFF IN PRODUCTION (07/2026, owner directive — temporary, pre-launch testing)**: `NEXT_PUBLIC_FREE_ACCESS_MODE = "1"` is set in `apps/app/netlify.toml` `[build.environment]`, so every paid capability is open to everyone: no subscription needed (expired trials included), unlimited household members, unlimited plan generations, advisor chat open, no post-onboarding bounce to /pricing, and no trial countdown banner. Every gate reads the ONE predicate `isFreeAccessMode()` (`apps/app/src/lib/subscription/freeAccess.ts`) — grep it for the complete list. **To take payments again: delete that one line from netlify.toml and redeploy.** Nothing else was loosened, so there is no second thing to remember. The LemonSqueezy checkout + webhooks are deliberately untouched and stay testable while the mode is on, as is the advisor's 30-messages/day cap (cost protection, not a paywall). Cost note: the weekly generation limits are a spend guard, and every generation is a paid Anthropic call — unlimited generations means unlimited AI spend while this is on. A «وضع الاختبار» badge renders on every page so the mode cannot be silently forgotten. Guarded by `freeAccess.test.ts`, whose most important assertion is that the mode is OFF for any value other than exactly `"1"`.

**Auth method**: Switched from magic-link (passwordless) to email + password. Supabase auth via signInWithPassword and signUp. Forms include both email and password inputs. **Password recovery exists as of the 07/2026 audit** — «نسيت كلمة المرور» on the login form → `resetPasswordForEmail` → `/auth/callback?type=recovery` → `/auth/update-password`. Before that there was NO reset path at all, so a forgotten password was permanent lockout of a paid account and the only operator tools were deactivate or delete. `/auth/update-password` is reached WITH a live recovery session, so proxy.ts exempts it from the "signed-in users get bounced off /auth/*" redirect, alongside `/auth/callback` and `/auth/logout`. Requires the Supabase recovery email template to be configured.

**Site architecture**: Merged from two Netlify sites to one unified site.
- Single production site: fitlife-app-mvp.netlify.app
- Landing page lives at apps/app/src/marketing (the live one)
- apps/web (the old standalone landing app) has been REMOVED — it was dead code; the landing is served from apps/app/src/marketing
- Old fitlife-landing.netlify.app site is decommissioned
- **apps/landing (07/2026, owner directive)**: a SEPARATE standalone one-page sales site for the «باقة التحوّل الشاملة» bundle offer (Salla checkout + WhatsApp invoice flow, 888 ر.س). Deliberately NOT connected to the app/website — no shared runtime code, no auth/analytics/Supabase; brand tokens are copied, not imported. Deploys on its own (Vercel, root dir apps/landing); CI builds it via `pnpm build:landing`. Pre-launch placeholders (Salla URL, logo, socials, OG image) are listed in apps/landing/README.md. Does not change the "single production site" status of the SaaS app above.
- **/landing route on the production site (07/2026, owner directive)**: the SAME bundle-offer page is ALSO served at fitlife-app-mvp.netlify.app/landing so it lives on the existing domain. Implementation: `apps/app/src/marketing/bundle/` (sections + config + page-local ui: badge/card/shimmer-button/number-ticker) composed by `apps/app/src/app/landing/{layout,page}.tsx` — its own thin layout (DirProvider only; NOT the (marketing) group, whose ScrollToTop FAB would collide with the page's mobile sticky purchase bar). `/landing` is in proxy.ts `isPublicRoute`. Offer gold tokens (`gold-500`/`gold-700`), the whatsapp color, shimmer keyframes and `bg-hero-spotlight` were added to apps/app globals.css. The page shares the app's Tajawal/RTL/brand tokens + the marketing accordion, but links nowhere into the SaaS funnel (WhatsApp only in Steps + Footer). **Checkout (07/2026)**: Salla's fast-checkout widget (store 1502078372 / product 1893963313, `SALLA` in `marketing/bundle/config.ts`), script loaded `lazyOnload` from the /landing layout. Two purchase points mount the widget (hero + `#checkout` finale); header/ledger-strip/sticky-bar CTAs are anchors to `#checkout` rather than extra widget instances. A custom element whose script fails to load renders NOTHING, so every slot ships a fallback button that CSS reveals via `.salla-slot:has(salla-mini-checkout-widget:not(:defined))` — set `SALLA.productUrl` to turn that fallback from a WhatsApp hand-off into a direct checkout link. NOTE: apps/landing and marketing/bundle are two copies of the same page — edits must be mirrored (or one of them retired) until the owner picks a single home.

**Bundle-page motion system (07/2026, owner directive «premium/animated»)**: one motion vocabulary for the whole offer page — `--ease-settle` as the ONLY curve, `--dur-fast/base/slow` (220/520/700ms) and `--reveal-stagger` (90ms) in globals.css; nothing hard-codes a timing. Scroll reveals are CSS-first, NOT Framer Motion: `Reveal` (bundle/`Reveal.tsx`, mirrored at landing `components/motion/Reveal.tsx`) is a SERVER component that only stamps `data-reveal` + a static `[--reveal-delay:*]` class, and one inline `RevealBootstrap` script in each page's layout runs a single shared IntersectionObserver. **The markup ships VISIBLE**: the rules that hide a section live ONLY in the stylesheet that script injects, and it injects nothing without an observer, under reduced motion, or if anything throws (plus a 1.5s post-load failsafe that pulls the sheet if the observer never fires) — the previous `RevealOnScroll` shipped `opacity:0` in the HTML, so a slow or broken hydration left the whole page blank below the hero. That is also why the flag is an injected stylesheet and not a class on `<html>`/`<body>`: mutating React-rendered attributes before hydration is a mismatch React reports and refuses to patch. `marketing/components/motion/RevealOnScroll.tsx` is now UNUSED (kept, not deleted — it lives in the shared marketing dir). Accents (`rule-grow`, `pop-in`) ride their ancestor's reveal instead of observing separately. Microinteractions are utilities (`lift`, `card-lift`, `link-underline`, `ledger-row`) and animate transform/opacity only. Sections 2→6 got a design pass on the receipt motif (dotted `leader-dots` ledger rows, `panel-elevated`/`edge-gold` paper, a threaded Steps rail, two-column FAQ, `section-shell` rhythm); the hero is unchanged apart from `hero-rise` → page-scoped `offer-rise` (the shared `hero-rise` still belongs to the SaaS marketing pages). FinalCTA is two-column with a photograph on the end side. **The finale is a PHOTOGRAPH of a real woman post-workout, supplied by the owner (07/2026)** — it replaced a generated «جاهزة» figure Lottie, which in turn replaced a «ختم الصفقة» receipt-seal Lottie; both animations and their generators are deleted (recoverable from git history at commits 5edb32d / 221ad65 if the direction ever reverses). The image is FRAMED in a rounded card with a hairline ring and the page's `edge-gold` top edge, so it reads as a deliberate object rather than a patch of background. Served via next/image with explicit width/height matching the file's real pixels — a plain `src` path, NOT a static import (that needs the `*.webp` declaration from the generated, gitignored `next-env.d.ts`, so it type-checks locally and fails in CI), hence no `placeholder="blur"`. Lazy by default since the section is far below the fold. `public/final-cta-woman.webp` is mirrored in BOTH apps and guarded by `finalCtaPortrait.test.ts` (copies identical, 4:5 ratio preserved, size budget). **The portrait was REPLACED 08/2026 (owner-supplied) with a branded studio shot — she wears the purple Fit Life top, so the photo now carries the brand instead of only the mood.** It changed the frame's own colours with it: the previous photo sat on a warm plum (#3E2B2C) a step off `bg-hero-night`, and needed both a matching card colour and a bottom gradient into `brand-purple-950` to dissolve its edge into the page. This one is shot on light studio grey (#EBEBEB) — a BRIGHT object on a dark field, already fully separated — so the card carries that grey and **the bottom fade is DELETED**: over a light backdrop it read as a dark smudge across her, not as a transition. Dimensions moved 1122×1402 → 1123×1400 (the source's native pixels, uncropped and unresampled); both `FinalCTAPortrait.tsx` copies and the test's expected numbers move together, since a mismatch would reserve the wrong box and shift the section as she loads. Compression: the owner's 79 KB WhatsApp JPEG → 40 KB WebP at q82 (PSNR 45.3 dB, no visible artefacts on skin or hair), re-encoded with Pillow; the raw upload is not kept in the repo (recoverable from git history at d8ef2db). `lottie-web` was dropped from apps/landing entirely with the animation; apps/app keeps it for the exercise form guides.

**Database migration baseline**: Production Supabase has migrations 00001 through 00007 applied (verified 06/09/2026 — 00007 `meal_mode` column confirmed present via a read-only REST probe of `family_members`). Migration 00005 added per-member fields (member_type, sex, allergies, dislikes, trimester, school_meal_handling, picky_eater) and family-wide preferences (cuisine, dietary_restrictions, cooking_methods, meal_out_frequency). Migration 00006 added `chat_messages`; 00007 added `family_members.meal_mode` ('shared' default / 'independent'). Migrations are applied MANUALLY (no CI/Netlify runner) — when adding a migration, apply it to prod yourself. Migrations 00008–00011 (admin_users, profiles.meal_mode, admin audit log), 00012 (superseded by 00014's composite index; see below), 00013 (Coach Sara questionnaire columns: target_weight_kg, day_nature/exercise_days/exercise_type, water_cups, sleep_hours, medications/supplements/nausea_foods jsonb, notes, family_members.feeding_mode, plus the optional deep-dive columns + profiles.deep_dive_completed_at — all nullable/additive, code works before it's applied but new answers won't persist) and 00014 (workout_plans table + workout_profile jsonb + plan_generations.plan_kind/workout_plan_id; REPLACES 00012's lock with UNIQUE (user_id, plan_kind) WHERE status='started' so one meal run and one workout run may coexist — apply BEFORE relying on workout generation) are NOT yet verified against prod — verify/apply before relying on the admin panel, the mom health-save (`profiles.meal_mode`), the generation race fix, or the new questionnaire fields.

**Migration state: everything through 00024 is applied to prod (00023 + 00024 applied by the owner 07/31/2026; 00001–00022 verified 07/26/2026).** 00023 widens the `subscriptions.status` CHECK to accept `'paused'` (00004 had dropped it, so every «استراحة» pause wrote a value the DB rejected). 00024 is the engineering-audit migration — see the audit section at the end of this file. Re-run `apps/app/scripts/verify-migrations.sql` after any new migration; it now also asserts a CLASS GUARD that every RLS table the app deletes from has a DELETE policy, because that omission has shipped twice (meal_checkins, fixed in 00019; meal_verdicts, fixed in 00024).

**Historical note (superseded):** the paragraph below was the 07/26 verification and is kept for its per-column evidence. Its closing claim that "the engagement code's pre-apply fallbacks are dormant" is now literally true for the ones that remain — the three `onConflict: "meal_plan_id,day_index,slot"` write fallbacks were DELETED in the audit, since 00019 drops that constraint and they could therefore only ever fail.

**Migration state VERIFIED AGAINST PROD 07/26/2026 — everything through 00022 is applied.** This supersedes the per-feature "NOT YET APPLIED"/"not yet verified" warnings still written into the sections below (00013, 00014, 00017, 00018, 00019, 00020, 00021, 00022); they are historical notes from when each was authored, not current state. Confirmed by a read-only column probe under a real user's JWT — `meal_checkins.member_id` (00019), `body_logs.photo_path` (00018), `workout_checkins.member_id` (00020) and `.intensity` (00022), `meal_absences.member_id` (00021), `meal_verdicts.canonical_key` (00017), `workout_plans.status` + `profiles.workout_profile` (00014), `profiles.deep_dive_completed_at` (00013), `profiles.meal_mode` (00009–00011) all present — plus an end-to-end UI check on prod: tapping «طبختها كما هي» wrote a `meal_checkins` row (`member_id: "mom"`, `local_date` stamped), the «كيف كانت؟» verdict control appeared only after it, `meal_verdicts` persisted, and un-tapping deleted the check-in while the verdict survived (the documented contract). The engagement code's pre-apply fallbacks are therefore dormant, not load-bearing. Re-verify with `node apps/app/scripts/qa-e2e/probe.mjs` + `engagement.mjs` after any new migration.

**Engagement layer spine (07/2026, Sprint 1)**: Migration 00017 adds the product's first event tables — `meal_checkins` (`local_date` stamped at write time as the universal calendar key, `slot` is extensible TEXT with no CHECK so Ramadan slots later are config not migration), `member_exceptions` (sparse, dish-directed kinds only — child consumption tracking is unrepresentable), `meal_verdicts` (keyed by server-minted `canonical_key` from `canonicalRecipeKey()` in plan-engine — meals have no UUIDs and regen re-words names), `body_logs` (dated weight/waist series; ADULTS ONLY enforced in app code by birth_year, never children). House RLS pattern + updated_at triggers. NOT YET APPLIED to prod — apply manually after 00016, re-run scripts/verify-migrations.sql (now covers 00016–00019), then `pnpm --filter @fitlife/app db:types` to regenerate types (until then, engagement code types rows via `apps/app/src/lib/engagement/types.ts` and untyped client casts — see the export route). /api/account/export includes the four tables (tolerant of pre-apply prod); delete is covered by CASCADE. Design contract in product/engagement-layer-brainstorm.md: unanswered = unknown (never fabricate adherence), rewards attach to rituals/verdicts never adherence counts, no shame states.

**Per-person check-in status (07/2026, owner directive)**: Migration 00019 (apply after 00018) adds `meal_checkins.member_id` ("mom" | family_members.id, same convention as meal_verdicts), swaps the unique key to (meal_plan_id, day_index, slot, member_id), and adds the previously-MISSING DELETE policy (00017 shipped without one, so every "clear my mark" tap was a silent RLS no-op) — on a shared meal each participant has a separate status (the MealCard tracking section renders one chip row PER PARTICIPANT; the header badge shows the viewed member's own status). Whole-house rows (`'household'` sentinel: legacy pre-00019 data, stale-tab writes via the zod default, and ختام اليوم `closeDay` — whole-kitchen attestation, no UI yet) are a read-time FALLBACK for members without their own row and are NEVER deleted by a per-member set (member_exceptions cascade off them; the digest needs the attestation) — but CLEARING sweeps the fallback too (fix 07/2026): un-tapping a chip means the meal carries no mark, and a surviving household row simply re-lit it with whatever the kitchen last attested (usually a legacy «تجاوزتها», which read as "un-clicking marked it skipped"). Both clear paths go through `clearMealMarks` in `engagement/actions.ts`, keyed by (user, `local_date`, slot, member) — the SAME key /plan reads by, so an older same-week plan version's row can't hand the chip back either (the page reads check-ins calendar-wide across plan versions while the old delete was scoped to meal_plan_id + day_index). `engagement/checkinMap.ts` is the one client-side definition of that read/clear pair (`resolveCheckin` / `checkinClearKeys`), used by PlanViewer's optimistic map so the tap and the server agree. Pre-00019 prod: reads degrade via `select("*")`. The WRITE fallback that once degraded to the legacy household shape is GONE (audit 07/2026) — it targeted the 3-column unique key that 00019 itself drops, so with 00019 applied it could only ever fail; a transient upsert error took the slow path to a second, misleading error. `computeEngagementDigest` collapses per-person rows by (local_date, slot) BEFORE the signal floor and all counts, so everything stays MEAL-true (a family of five skipping one dinner is one skip, never five, and household size can't buy the digest into existence — both digest fetchers select local_date); admin `checkins7d` counts distinct meals for the same reason; recap day-cells were already per-date. Statuses are about the dish serving, never amounts — the no-consumption-surveillance stance is unchanged.

**Engagement UI surfaces + workout check-ins (07/2026)**: The first customer-facing engagement surfaces shipped on /plan (all interactive-Arabic-view only — never history/housekeeper/PDF): (1) `«سارة عدّلت خطتك»` card (`SaraChangesCard`) renders `plan_data.week_changes` (data already emitted by the engine; no query change); (2) inline dish verdicts «كيف كانت؟» (نحبّها/عادية/لا تكرّريها) via `setMealVerdict` — the first customer write surface for `meal_verdicts` (closeDay still has no UI), shown under a meal only once the viewed member marked it cooked, per-person keyed (plan, member, day, slot); (3) `«موسم بيتنا»` family season (`FamilySeasonCard`). **Design history:** first shipped cooperative (no ranking) per the engagement research; then the **owner reviewed and DIRECTED a competitive ranked leaderboard (07/2026)** — the original brief in `product/family-engagement-research-and-plan.md` §0. Now renders a per-member LEADERBOARD: a shared top card (meal-true family total ring + pride line + most-consistent member + a 7-day meal strip with per-day star ratings) above ranked adult cards — a celebrated gold **#1 «فائز هذا الأسبوع»** with a crown, and purple rank cards (#2…) each with a weekly participation %. Ranking metric = meal marks + verdicts + workout marks; % = acts/`WEEKLY_TARGET`(10). **Counted meal statuses (owner directive 07/2026): ONLY «طبختها كما هي» (`status: "cooked"`).** «بدّلتها» (swapped) and «تجاوزتها» (skipped) score NOTHING on any number of the card — family ring, 7-day strip/stars, `activeDays`/«أتممتم موسمكم», the «اليوم» panel's `alreadyLit`, and every member's score/% all read the same single filter (`isCookedAsIs` in `seasonMath.ts`, one place so the surfaces can't fork). This supersedes the earlier "a meal that happened = cooked OR swapped" rule. Scoped to the leaderboard only — the weekly recap, `computeEngagementDigest` (Sara's adaptation), and the /plan chips still read every status, so honest logging is unchanged. Workout marks keep counting done + moved (a moved session was still trained). The cooperative guardrails (no last place, no per-person numbers) are intentionally superseded here by owner direction; the research recommendation remains on file. **Roster (owner directive 07/2026): the WHOLE household — mom + adults + CHILDREN — via the server's `seasonMembers` (mom + every non-housekeeper family member), NOT `journeyMembers`. Children rank exactly like adults and may take the #1 «فائز» spot; the earlier no-sibling-comparison stance is superseded alongside the cooperative guardrails. The housekeeper is never in the roster; weight/goal celebration (`goalReached`) + the private `«رحلتك الخاصة»` journey stay adults-only via `engagement/eligibility.ts` (a separate feature).** Hidden for solo/housekeeper/history. Migration **00020** (apply after 00019) adds `workout_checkins` (per-member; `day_index` WEEKDAY-anchored 0=Sunday unlike meal_checkins; `local_date` stamped server-side; DELETE policy day-one; done/moved/skipped validated in Zod). `WorkoutViewer` gained inline session marking (`setWorkoutCheckin`, whole-current-week window derived from the session's weekday with a 48h floor — see the marking-window directive below) and now takes `planId`+`checkins`; the season reads meal check-ins/verdicts + workout check-ins. 00020 NOT YET APPLIED to prod — apply after 00019, re-run scripts/verify-migrations.sql (now covers 00020), then `pnpm --filter @fitlife/app db:types`; until regenerated, page.tsx/export read `workout_checkins` via an untyped cast (pre-apply tolerant = []). /api/account/export includes `workout_checkins`; delete is CASCADE.

**Shared meals: single status + absent-member adjustment (07/2026, owner directive)**: A SHARED meal now carries ONE status for the whole dish — the per-participant chip rows from the 00019 pivot are SUPERSEDED for shared meals (individual meals still track the tab's member; 00019's schema/DELETE policy stay load-bearing). One tap on the shared card answers for everyone who shared it: `setSharedMealCheckin` fans the same status out as one row per PRESENT participant (atomic upsert; NOT a `'household'` row — that would gut the leaderboard's per-member credit and bleed onto non-sharers' individual meals in the same slot via the read-time fallback). Read side: `PlanViewer.sharedCheckinFor` = any sharer's row (fan-out keeps them agreeing) → household fallback (legacy/ختام اليوم), both via `engagement/checkinMap.ts`. Un-tapping is the mirror image of the tap: ONE tap un-answers the dish for every sharer AND retracts the household fallback (`clearMealMarks`), calendar-keyed across plan versions — without that, the cleared chip re-lit itself from the leftover row. Digest/season math is untouched — rows still collapse by (local_date, slot) so a fan-out is still ONE meal. Second half of the directive: a sharer can be excluded from one meal occurrence («إزالة من الوجبة» on the portion row) and the card ADJUSTS the batch for the remaining sharers — dish never changed/regenerated, purely deterministic scaling in `apps/app/src/lib/plans/sharedMealAbsence.ts` (portion_percentage → portion_grams → headcount; unit-aware rounding; batch weight = sum of present grams). Absence is a PLANNING fact, not adherence: it works on FUTURE days (no future-gate in `setMealAbsence`, unlike marks), lives in migration **00021** `meal_absences` (sparse, keyed plan/day/slot/member, cascade with the plan, DELETE policy day-one), and marking absent also clears that member's own status row (no serving to attest, no leaderboard credit) while their dish VERDICTS survive (an opinion is theirs) and the «كيف كانت؟» control hides on their tab for that meal. The last present sharer can't be removed (a meal for nobody is a «تجاوزتها», not an adjustment). Restoring a member re-attaches them to the dish's current status (client mirrors the donor mark via a one-member fan-out AFTER the absence delete — the fan-out is server-filtered against meal_absences, so order matters). Toggle lives on interactive-Arabic /plan only; the dashboard «وجبات اليوم» shows the same adjusted batch READ-ONLY (history/housekeeper/PDF render the stored plan unscaled; housekeeper-view scaling is a known follow-up). Slot-keyed like all engagement rows — a day with two snack-slot meals shares one absence/status key (inherited engagement-layer limit). 00021 NOT YET APPLIED to prod — apply after 00020, re-run scripts/verify-migrations.sql (now covers 00021), then `pnpm --filter @fitlife/app db:types`; until then reads degrade to [] and absence writes fail with a Sentry warning. /api/account/export includes `meal_absences` (pre-apply tolerant); delete is CASCADE.

**Out of a meal ⇒ «بدّلتها» or «تجاوزتها» only (07/2026, owner directive)**: A member excluded from a shared occurrence gets a REDUCED status row on their own tab — «طبختها كما هي» is gone, because the planned dish never reached them; the two honest answers left are بديل or تجاوز. The vocabulary lives in `OUT_OF_MEAL_CHECKIN_STATUSES` (`engagement/types.ts`, filtered from `CHECKIN_STATUSES` so it can't fork); `MealCard` renders it via the `CheckinChips` `chips` prop plus the line «{الاسم} خارج هذه الوجبة — التسجيل هنا: بديل أو تجاوز» in place of «تسجيل واحد للوجبة المشتركة». This splits the two meanings a `meal_checkins` row can carry, and the split is enforced on both sides: a PRESENT sharer's row IS the dish's single status (fan-out via `setSharedMealCheckin`), an ABSENT member's row is PERSONAL. So (a) an absentee's row no longer lights the shared chip and is no longer swept by a shared clear — `PlanViewer` passes present sharers only (`dishIds`, one roster for set AND clear; the earlier "present-first, absentees last" fallback list is superseded); (b) their tab reads their OWN row with NO household fallback (`ownCheckin` in `checkinMap.ts`; a leftover `cooked` row from before the exclusion is ignored, never shown as theirs) and routes writes through `setMealCheckin`, not the shared fan-out; (c) clearing it does NOT retract the whole-house attestation (`clearMealMarks`/`checkinClearKeys` gained `sweepHousehold`, and the SERVER decides the scope from `meal_absences` via `isOutOfMeal` — a stale tab never gets to choose); (d) `setMealAbsence` now resets the member's own status row in BOTH directions (was: only on exclude), since on restore that personal record would otherwise become the whole dish's status. Leaderboard/digest/recap math is untouched — only «cooked» scores, so an out-of-meal mark still earns nothing, and rows still collapse by (local_date, slot). No new migration (00021 covers it). Same scope as the rest: interactive-Arabic /plan only, never history/housekeeper/PDF/dashboard.

**A family meal is a DISH, not a slot (07/2026, owner directive «present the real numbers»)**: «موسم بيتنا» told a house it had cooked 3 meals in a day when it had cooked 5, and marking the 4th and 5th moved no number — the family total counted distinct `(day_index, slot)` pairs. Correct for a shared dish (three people marking one lunch is ONE meal; household size must never inflate the ring) but wrong whenever a day holds more than one dish in the same slot, which Sara's family methodology produces routinely (a member gets their own recipe when the shared pot doesn't suit them). Family-level identity is now `(day, slot, DISH)`: `seasonProps` builds `dishKeys` (`${day_index}|${slot}|${member_id}` → `canonicalRecipeKey(recipe_name_ar)`, key format in `seasonMath.dishKeyFor`) from the plan and `computeSeasonStats` counts distinct dishes — sharers of one pot resolve to the same key and still collapse to one meal. Unresolvable marks (the `'household'` sentinel, a member dropped from the roster, a re-minted plan) fall back to slot identity AND only when no identified dish already covers that slot, so a degraded read can never inflate; with no `dishKeys` at all the figure is exactly the legacy count. The strip's star denominators moved to the same key space (`plannedMealsPerDay`, renamed from `plannedMealSlotsPerDay`; `SeasonDayCell.cookedSlots/plannedSlots` → `cookedMeals/plannedMeals`), and BOTH sides are derived identically — for one member a day's duplicate slot (two snacks) yields one markable unit on each side, so 100% stays reachable. The ring fills toward `weeklyCapacity` (planned dishes + planned sessions for that household) instead of the fixed `CAP` of 14, which a large family would now fill by midweek. Copy follows the number: «هذا الأسبوع طبخ بيتكم N وجبات كما هي من الخطة» with the ring labelled «وجبات مطبوخة» — it no longer claims «معاً», since the figure now includes a member's own dish. PER-MEMBER counts keep `(day, slot)` identity (`plannedMealSlots`) — one person marks at most one row per slot. Statuses are unchanged (only «طبختها كما هي» scores), as are the digest, weekly recap, and /plan chips.

**Marking window — whole plan week (07/2026, owner directive)**: Every meal stays changeable for the WHOLE plan week, not just a 48h retroactive window — the earlier «retroactive-first, 48h grace» stance (still described in `product/engagement-layer-brainstorm.md`) is superseded so a mom can complete or correct any earlier day before the week rolls over into history. The rule is «any elapsed day of the plan week is markable, never a future day» (adherence is never pre-marked), enforced in BOTH the client gate (`PlanViewer.canCheckinActiveDay` = `activeDayIndex <= dayIndexFromWeekStart`) and the server actions (`setMealCheckin`/`setMealVerdict`/`closeDay` reject only `localDate > today`; `day_index ∈ [0,6]` keeps it inside the plan week). Once a new week's plan supersedes the current one, the old plan moves to read-only /plan/history, so the week «locks» by plan supersession, not a date bound. Workout sessions (weekday-anchored, 0=Sunday) mirror this: `setWorkoutCheckin` derives the date by scanning back `max(todayWeekday, GRACE_DAYS)` days so the whole current week is markable, keeping the 48h floor for the previous week's tail (`WorkoutViewer.canMarkActive` uses the same bound). Because verdicts + workout marks both feed the «موسم بيتنا» leaderboard (which lives on the dashboard), `setMealVerdict` and `setWorkoutCheckin` now `revalidatePath("/dashboard")` in addition to `/plan` (they previously revalidated only `/plan`, so the board went stale after an exercise/verdict change) — `setMealCheckin` already did both.

**Private journey — now WHOLE HOUSEHOLD incl. children (07/2026, owner directive)**: «رحلتك الخاصة» (/journey, «الوزن والمتابعة») is a private weight-over-time record — `?member=<family_members.id>` (default mom), member switcher chips, per-member weekly cadence and scalar weight mirror (profiles.weight_kg for mom, family_members.weight_kg for members). **Design history:** first shipped ADULTS-ONLY (children never weight-tracked — the 00017 stance + engagement §6 guardrail 1). The **owner then DIRECTED including children** (07/2026), with the child-safety trade-offs surfaced. To keep the reversal narrow, `apps/app/src/lib/engagement/eligibility.ts` now splits into THREE gates: `isWeighInEligibleMember` = may keep a PRIVATE record, PHOTOS included (adults **and children**; housekeeper NEVER — dignity rule) → journey page + /plan per-tab entry + logBodyWeight write gate; `isChildWeighInMember` = the member is a minor (now used ONLY to keep minors off the shared goal celebration); `isGoalCelebrationEligibleMember` = ADULTS ONLY → the shared «تحقّق الهدف» on «موسم بيتنا» (`seasonProps.ts` goalReached uses THIS, so a child's weight goal is never on a shared surface). **The ONE thing that stays adults-only is the shared goal celebration.** BODY PHOTOS were adults-only at first — the minor-photo block lived in three layers (`WeighInForm`'s `allowPhotos` prop, the journey page's photo-signing guard, and a `photo_path`-nulling branch in `logBodyWeight`) — but a **LATER owner directive (07/2026) extended progress photos to children too, with the child-safety trade-offs surfaced.** All three blocks were REMOVED (the `allowPhotos` prop is gone entirely); every eligible member (adults + children; housekeeper never) may now attach a private photo. Nothing about the photo's privacy changed: it stays a per-account, private, journey-page-only record — masked by default, signed URLs only, never on «موسم بيتنا» or any shared surface, never in admin. A child journey is a neutral weight record by construction (the target/loss line is mom-only; recap `weight_delta` is mom-only). pregnant/lactating eligible but no loss-framing. The dashboard quick-link was REMOVED — the entry now lives on /plan as a per-member-tab card (PlanViewer `journeyMembers` prop; interactive page only, never history/housekeeper/PDF). Migration 00018 (NOT YET APPLIED, after 00017): `body_logs.photo_path` + PRIVATE `body-photos` storage bucket (5MB, jpeg/png/webp, owner-scoped storage.objects policies by first path segment `<user_id>/`; the bucket is per-account, so a child's photo lives in the parent's own folder — WHO may attach one is app policy, not SQL). Photos upload browser→bucket directly, render ONLY via short-lived signed URLs on /journey behind a masked-by-default reveal (plain `<img>` on purpose — the next/image optimizer would cache private photos), and never appear in messages/recap/share cards/admin. PDPL: storage does NOT cascade — `eraseUserAccount()` removes the `<user_id>/` folder explicitly (best-effort, before auth delete); /api/account/export attaches 24h signed `photo_url` per log (best-effort, pre-apply tolerant). Weight-only saves still work pre-00018 (photo_path key is omitted when absent).

**Doctor sign-off — ONE rule (07/2026)**: `packages/plan-engine/src/medicalGate.ts` is the single definition of who needs `consulted_doctor` before a plan. `ownerRequiresDoctorSignOff` = ANY medical condition (chips + the free-text «حالة أخرى», which the save actions append to `medical_conditions`) OR pregnancy at ANY risk level; `memberRequiresDoctorSignOff` = HIGH-risk conditions or a high-risk pregnancy only (deliberately narrower — one member's unanswered checkbox must never block the household). It was previously re-derived in five places with five different rules, and the engine's was the broadest: a PREGNANT LOW-RISK owner was permanently blocked from generating while neither the wizard nor `/profile/health` ever showed her the checkbox (both keyed off `highRisk === true`), and a stable condition saved from `/profile/health` with the box unticked did the same. `buildContext`, the SDK-free background function, `MomWizard`, `HealthEditForm`, `saveMomProfile`, and `saveMomHealthInfo` all call it now — save is REFUSED when the rule applies and the box is unticked, so a profile the UI accepts is always one the engine will plan for. Recovery for rows saved before the fix lives on **/plan**: `EmptyState` renders the confirmation inline (`confirmDoctorConsult` in `app/plan/actions.ts`) instead of a create button that could only ever come back refused; `/api/plans/generate` marks that denial `gate: "medical"` and the dashboard CTAs route there on it. Exhaustively guarded in `apps/app/src/qa/deadEnds.test.ts` (UI-asks ⇔ engine-blocks over the whole owner input space).

**Goal mapping — a stable condition no longer erases the goal (07/2026)**: `mapUserGoalToSara` used to route ANY condition away from the stated goal, so PCOS or anemia + «خسارة الدهون» silently became `metabolic_health` with no deficit at all — and PCOS is very common in this audience. Now only a HIGH-RISK condition leads the plan (`hasHighRiskCondition` from `plan-engine/medicalGate` — the same list as the doctor gate, so there's one definition); a stable condition is respected through the roster/day-prompt condition clauses and the methodology's per-condition rules instead. Two deliberate consequences: `build_muscle`/`athletic` are no longer immune to the override (they were, for no stated reason — a high-risk condition now leads them too), and «تحسين الحالة الصحية» stays condition-led for ANY condition because that IS the ask. `hasGateCondition` in `medicalConditions.ts` now delegates to the engine list too (the two had drifted by `unexplained_symptoms`).

**Prompt precedence: methodology over cookbook (07/2026)**: `SARA_COOKBOOK` read as absolute bans («لا تستخدمي أرز أبيض كمكون رئيسي»، no regular pasta, no white bread) that contradicted `SARA_METHODOLOGY`'s own Gulf staples list (كبسة، الجريش، المرقوق، السمك مع الأرز) and its «لا حرمان» principle — and being the LATER block in `STATIC_SYSTEM`, it won, so plans systematically avoided the dishes the product promises. It also stated a per-recipe band of 120-430 kcal/serving which cannot add up to an adult day target, which the per-day band enforcement then fought with re-rolls (visible in the test logs as «out of band after 2 corrective re-rolls»). Fixed by: an explicit «ترتيب المراجع عند التعارض» section at the end of `STATIC_SYSTEM` (safety → day targets → allergies → Gulf staples/لا حرمان → cookbook style), a matching «الأولوية عند التعارض» paragraph inside the cookbook block, reframing the bans as «تفضيلات الأسلوب (افتراضات، لا محرّمات)» with rice-based Gulf dishes served «بمقدار موزون» rather than replaced, and restating the serving size as derived from the day target (snacks 120-320, main meals up to 600-800). The block was also rewritten in فصحى with Western digits (it was عامية, and «أنتي» was a misspelling of «أنتِ»). Guarded by `promptQuality.test.ts`. NOTE: this invalidates the cached static prompt block once on deploy.

**Postpartum without lactation (07/2026)**: `months_postpartum` is «months since giving birth» for the account owner, NOT a lactation flag — `member_type === "lactating"` is what adds the lactation calories. It was only stored for lactating owners, so a woman who formula-feeds selected «لست حاملاً ولا مرضعة» and got no recovery rules at all (and no pelvic-floor/core caution in the workout program, whose `describeTrainee` already keyed off the column). Both the mom wizard's pregnancy step and `/profile/health` now ask «هل ولدتِ خلال آخر 12 شهراً؟» when she is neither pregnant nor lactating; `describeMom` renders a recovery clause («لا تضيفي سعرات الرضاعة» + protein/iron/fibre/gradual-change) instead of the lactation clause. Never set while pregnant, never for a male owner. Family members are unchanged (no non-lactating postpartum member type exists).

**Child rule — ONE definition (07/2026)**: `packages/plan-engine/src/childRule.ts` (`isChildByAge` / `isChildByBirthYear`) decides who is planned by food-pyramid PORTIONS instead of BMR/TDEE — `member_type === "child"` OR under 18. It was applied to family members in three places and to the ACCOUNT OWNER in only one: `generate.ts`'s assembly stamped `is_child` for an under-18 owner (and `reconcileChildTargets` rewrote her header) while `describeMom` emitted no child clause and `buildDayPrompt` handed her an adult calorie target — so a 15-year-old signup got an adult deficit plan displayed as a portions plan, against the methodology's own «لا تستخدمي معادلات BMR/TDEE للأطفال إطلاقاً». `buildContext`, `describeMom`, `buildDayPrompt`, `dayCalorieDeviations`, `dayProteinDeviations`, `isChildById` and the app's read-time `applyChildDisplayTargets` all call it now. A minor owner also skips the weight-target clause. Signup accepts 13+ (both `step1Schema` AND, since this fix, `momProfileInputSchema`/`profileStepSchema` — the server used to allow any birth year up to the current one).

**Member edit → regeneration (07/2026)**: `apps/app/src/lib/plans/memberEdit.ts` diffs the whole built row against the stored one instead of the hand-maintained field list `updateFamilyMember` used to carry. That list silently omitted **allergies**, `height_cm`, `dislikes`, `trimester` and `months_postpartum` — adding a nut allergy to a child saved the row and left the nut-containing plan on screen. Only `name`, `user_id` and `preferred_language` are cosmetic (the first shows through `applyMemberDisplayNames`; the housekeeper's language triggers a translation pass, not a regeneration). Numeric columns that Postgres returns as strings compare numerically. Guarded by `memberEdit.test.ts`.

**Activity for pregnant/lactating members (07/2026)**: their calories are maintenance (TDEE) plus a stage addition, so they need an activity factor exactly like an adult. The `exercise` step (طبيعة اليوم × أيام الرياضة) is now in the pregnant and lactating `MemberWizard` flows, and `buildMemberRow` stores `day_nature`/`exercise_days`/`exercise_type` + the derived `activity_level` for all three adult-like types — previously adult-only, which left `activity_level` null for both and made `describeMember` omit the clause entirely, so the model guessed the multiplier. `target_weight_kg` stays adult-only (pregnancy and lactation are not weight-change goals).

**Family-member validation bounds (07/2026)**: `familyMemberInputSchema` now matches the `family_members` DB CHECKs and the wizard's own `physicalRangeError` (40-250 cm / 5-300 kg). It required 80 cm / 20 kg, so every child under about six was rejected AFTER the wizard accepted them, with the opaque «بيانات غير صالحة» and no field named. Rejections now surface the field-level Arabic message via `firstFieldErrorAr` (which only forwards OUR Arabic messages, never zod's English defaults).

**Onboarding restructure (Prompt 1.8c)**: 5 family-wide questions → Mom's personal questions → sequential per-member additions with branched wizards (adult/child/pregnant/lactating). Solo plans hide member tabs.

**Coach Sara questionnaire (07/2026)**: Mom's flow is now 10-11 adaptive steps (step-key array). `activity_level` is DERIVED in `apps/app/src/lib/plans/activityLevel.ts` from the concrete day-nature × exercise-days answers (12-row table matching the Saudi MOH calculator buckets/multipliers already in SARA_METHODOLOGY); raw answers stored alongside. UI goals are the coach's six (`lose_weight/build_muscle/recomposition/maintain_weight/athletic/improve_health` → canonical incl. promoted `maintain`/`general_health`). New per-person fields (target weight, exercise, water, sleep, meds/supplements, mom notes, pregnancy nausea_foods, lactation feeding_mode) thread DB → buildContext (+ the bg function's SDK-free mirror) → skeleton roster clauses; ONLY meds+nausea repeat in day prompts. Optional deep-dive screen at /profile/deep-dive (dashboard banner + profile card) fills the full-questionnaire extras into a skeleton-only lifestyle block. Onboarding server actions are zod-validated via `onboarding/serverSchemas.ts`; the level is always re-derived server-side.

**Workout plans (07/2026, meals-first fork)**: meals and exercise are SEPARATE plans. Onboarding ends at `/onboarding/plan-scope` — "وجبات فقط" (previous path) or "وجبات وتمارين معاً" (7 workout questions per opted-in adult at `/onboarding/workout`, stored as `workout_profile` jsonb; children/housekeeper never eligible). Combined generation: `maybeTriggerWorkoutGeneration` fires from `generateSoloAndContinue`/`syncFamilyPlanAfterSubscribe` (regardless of the meal result; idempotent under 00014's per-kind lock). Engine: `packages/plan-engine/src/workout/` — WORKOUT_METHODOLOGY is an ACSM/NSCA-grade resistance-training block authored in-house (فصحى, cached-static, ACOG-aligned pregnancy + injury safety rules; PENDING Coach Sara review — swap text, not code). Two-phase: skeleton (split+sessions, SKELETON_MODEL) → one full-week expansion per member (DAY_MODEL). Same background function via `mode:"workout"` (own idempotency probe by workout_plan_id); status at `/api/plans/workout/status` (the meal status route is untouched — 3 pollers depend on its shape); viewer via `/plan?view=workout` toggle + `WorkoutViewer`. Post-onboarding opt-in: dashboard banner + profile entry → immediate dispatch. v1: no manual workout regenerate (edit answers → next combined trigger); /plan/history stays meal-only; workout available on all paid tiers; admin per-plan cost map excludes workout rows (spend still lands in totals).

**Exercise form animations (07/2026)**: every exercise row in `WorkoutViewer` taps open a brand-colored Lottie form guide. Fixed catalog `packages/plan-engine/src/workout/exerciseCatalog.ts` (72 ids + `FALLBACK_BY_PATTERN`): the roster is embedded in the cached `WORKOUT_STATIC`, the model MUST emit `exercise_id` (+ `home_variant_id` for location="both") from it; unknown ids are nulled log-only (`normalizeExerciseIds`) so runs never fail — id-less exercises just don't expand (old plans keep rendering). Assets are generated IN-REPO (no licensing): `apps/app/scripts/lottie-exercises/` (parametric figure rig → Lottie JSON; QA via headless-Chromium screenshot sheets) → `apps/app/public/lottie/exercises/<id>.json` (~13 KB each, lazy-fetched per expanded row by `ExerciseLottie.tsx` via `lottie-web` light build; reduced-motion → still frame + play). `exerciseAnimations.test.ts` keeps catalog↔files in lockstep — run `node scripts/lottie-exercises/generate.mjs` after editing the catalog or poses. **Meals-first sequencing**: the workout background run holds while a meal generation is live (`mealGenBlocksWorkout` polled every 10 s, 8-min cap, stale >15 min ignored) so meals always get the full API budget; `/api/plans/workout/status` exposes `waiting_for_meals` and the generating card shows «نجهّز وجباتك أولاً».

**Workout training days + intensity adaptation (07/2026, owner directive)**: two intake/loop gaps closed. (1) **Chosen weekdays**: `workout_profile.preferred_days` (0=Sunday…6=Saturday, the workout day_index convention; optional — legacy profiles without it keep model-picked spacing). Onboarding's shape screen gained a weekday chip picker (count must equal desired_days, chips disable at the cap, shrinking desired_days trims the selection). The roster line renders the days as a mandatory clause and `normalizeWorkoutSkeleton`/`normalizeMemberSessions` REMAP sessions onto the chosen days deterministically (i-th session in week order → i-th chosen day; chosen days also become the session-count cap) — the user's calendar always wins over the model's spacing. (2) **Intensity feedback loop**: migration **00022** (apply after 00021, re-run scripts/verify-migrations.sql — covers 00022) adds `workout_checkins.intensity` (easy/right/hard, nullable, Zod-validated, no DB CHECK). WorkoutViewer shows «كيف كانت شدة الحصة؟» chips only on a «أنجزتها» mark; any non-done status write resets intensity (stale ratings must not steer). Pre-apply prod: the action retries the upsert without the column + Sentry warning, so marking keeps working. Before a workout generation the bg function reads 21 days of checkins, `summarizeWorkoutFeedback` (plan-engine `workout/feedback.ts`) collapses them per member (intensity counted on done rows only; <2 rated sessions = no signal, nothing fabricated), and `workoutFeedbackClause` renders a numbers-first فصحى directive on the trainee line (mostly-hard → deload, mostly-easy → add challenge within RIR 1-3, balanced/tie → hold) + a methodology «التكيّف» rule making the actual rating outrank assumptions. Export ships the column via select(*); board math ignores intensity (pass-through only).

**Workout location/equipment fit (07/2026, owner directive)**: a program must match the trainee's declared location + tools 100% — gym plans were coming out near-identical to home plans. Three layers, all in `packages/plan-engine/src/workout/`: (1) the catalog grew a real gym tier (72 ids: barbell squat/deadlift/hip thrust, machine chest/shoulder press, hip abduction, cable glute kickback/lateral raise/biceps curl, reverse pec deck, seated calf raise, rowing machine, elliptical — each with an in-repo Lottie pose) plus `towel_row`/`superman` so a no-equipment home user has a legal pull/back pattern; (2) prompts state the rules (methodology «المكان والأدوات» is now mandatory-worded: gym plans must put ≥half of strength work on gym gear; the phase-2 member prompt embeds the trainee's exact allowed `exercise_id` list for home, and the allowed `home_variant_id` list for both); (3) `equipment.ts` ENFORCES it post-parse via `enforceWorkoutProfileFit` called from generate.ts — home: only `home_ok` + declared tools (wall/box/bench count as furniture; home «أجهزة منزلية» = treadmill/bike cardio ONLY, label clarified in onboarding); gym/both: `GYM_GEAR_SHARE_FLOOR` (0.5 of strength patterns on machine/barbell, waived for pregnant/≤3-mo-postpartum); both: every gym-gear exercise must carry a home-legal `home_variant_id`; stray variants on non-both members are stripped (kills the phantom «نسخة المنزل» toggle for gym users). Violations re-roll the member call (within MAX_RETRIES); the FINAL attempt applies deterministic repairs from `HOME_SUBSTITUTE`/`PATTERN_STAPLES`/`GYM_UPGRADE` (pregnancy-safe filtered) and logs — a member is never dropped over equipment fit. Tables are integrity-tested (`equipment.test.ts`): every id resolves a no-equipment home substitute, pregnant or not.

**Generated plan text follows the reader's gender (07/2026)**: the React UI already inflected via `genderPick`, but the AI PROMPTS still hard-defaulted to feminine, so a male owner's *plan content* — recipe steps, notes, workout cues — came back addressed to a woman. Fixed at the prompt layer in `packages/plan-engine`: (1) MEALS — the phase-2 day prompt's «صيغة المؤنث» line is now derived from the owner's answered الجنس via `ownerG(context)` (`systemPrompt.ts`), which also genders the «العميلة/العميل» questionnaire headers and the name-less-owner fallback in `buildContext.getBeneficiaries`; the methodology's safe-calorie floors, which were stated for «المرأة البالغة» only, now say explicitly that they are FEMALE limits and point a man at the relative-deficit rule + his own BMR as the floor (**pending Coach Sara sign-off — the only clinical wording added**). (2) WORKOUTS — `WORKOUT_ROLE` no longer advertises a women-only specialty; the cached methodology's feminine-plural trainee nouns (المبتدئات/المتوسطات/المتقدمات) became inclusive masculine-plural per the house convention, and «اعتبارات خاصة بالنساء» is now «اعتبارات حسب الجنس والحالة» with postpartum scoped to women and an explicit bar on pregnancy/postpartum content in a man's program; the roster line follows each TRAINEE's own sex (`traineeIsMale`) instead of labelling everyone «العميلة (الأم)»/«متدرب»; and the phase-2 member prompt carries a mandatory «صيغة الخطاب» block keyed to that trainee. Voice for meals = the OWNER (the plan's reader); voice for workouts = the TRAINEE (each program is read by its own person). Feminine stays the fallback for an unanswered/legacy `sex`, matching `lib/copy/gender.ts` — it is no longer a blanket default. Changing `WORKOUT_ROLE`/methodology/`SARA_METHODOLOGY` invalidates the cached static prompt block once on deploy. The HOUSEKEEPER's own sex is now ASKED (08/2026): an optional «هل من يطبخ رجل أم امرأة؟» on `HousekeeperForm`, stored on her `family_members.sex`, threaded into `buildTranslatePrompt`/`buildNameTranslatePrompt` via `cookNoun()` so the instructions say طبّاخ or طبّاخة to match. Optional on purpose — unanswered keeps the feminine fallback the rest of the product uses, rather than guessing. The edit path only writes the column when answered, so renaming her cannot blank an answer she already gave.

**AI generation**: Day-by-day streaming, incremental per-member updates that don't wipe existing family plans when adding/editing one member.

**Plan engine package**: Lives at packages/plan-engine (was originally inline in apps/app).

**Settings page**: PDPL compliance shipped — /settings has account info + data export + immediate hard-delete via typed-confirmation modal. Public routes /privacy and /terms exist with placeholder Markdown content (needs real legal text before scaling).

**Sara's Cookbook Inspiration (Prompt 3.3a)**: The AI system prompt now includes a structured profile of Sara's "كنز الوصفات الصحية" cookbook (101 recipes, high-protein/no-sugar/no-refined-flour). Recipes are NOT extracted verbatim from the PDF — instead, the AI generates fresh recipes that align with the cookbook's style, ingredient palette, and constraints. The block lives in `packages/plan-engine/src/systemPrompt.ts` as `SARA_COOKBOOK`, appended to the cached `STATIC_SYSTEM` after Sara's methodology (methodology takes precedence for medical/pregnancy needs). A non-fatal log-only guard in `generate.ts` warns on refined-flour/sugar deviations. PDF source (if added) lives in `product/sara-cookbook.pdf` for reference but is not parsed at runtime.

**A generating screen gives up on SILENCE, never on a wall clock (07/2026)**: both `PlanGeneratingState` and `WorkoutGeneratingState` used a fixed `TIMEOUT_MS = 780_000` (13 min) whose comment claimed it was «kept inside the background function's 15-min budget» — inside is exactly backwards. The bg function's day loop runs to `dayLoopDeadline` (budget − `FINALIZE_RESERVE_MS` ≈ 14.25 min) and writes its terminal row inside the reserve, so a healthy run lands at ~15 min and the client was calling it stuck at 13. Worse, refreshing from «العملية تاخذ وقت أطول من المتوقع» re-rendered the same card with a fresh clock (`resolveStaleness` won't reclassify while `updated_at` is fresh, and a live run keeps refreshing it), so the screen could cycle indefinitely without ever stating a fact. The wall clock is gone: `apps/app/src/lib/plans/generationTiming.ts` is now the ONE timing contract — it owns `STALE_GENERATION_MIN` (re-exported by `staleness.ts`, which keeps the server consumers reading it from the staleness contract) and derives `GENERATION_SILENCE_LIMIT_MS` = staleness + `SERVER_VERDICT_MARGIN_MS`, so the client always lands AFTER the server's reclassifier and the user gets a real screen (the plan, or the retry state) rather than the generic card. It is a leaf module on purpose: `staleness.ts` pulls `planHasContent` from the plan engine, and a client component importing that would drag the engine into the browser bundle. BOTH status routes now return **`age_ms`**, measured entirely server-side (a route handler may call `Date.now()`; a Server Component render may not — `react-hooks/purity`), which is also what removes device-clock skew from the question: the cards rebuild `lastWriteAt = now − age_ms` on every poll, so a run that is still writing is never called stuck however long it legitimately takes, a reloaded tab recovers the true age within one immediate poll instead of buying a fresh window, and a permanently-broken poll still resolves to an answer instead of an endless spinner. `PlanGeneratingState` also reloads on an id mismatch (the route reports only the LATEST plan, so a superseded tab could otherwise never see its own plan finish; page and route both resolve through `getLatestPlan`, so one reload always converges). The workout card keeps its deliberate meals-first exemption — the hold is the worker behaving correctly, not silence. Guarded by `generationTiming.test.ts`, which asserts the ordering against the ENGINE'S OWN budget constants, so raising the bg budget fails the suite instead of quietly recreating the bug. NOTE: none of this makes a dead run finish — it removes a FALSE stuck screen. A genuinely stuck run is diagnosed from the `plan_generations` row (still `started` with NULL cost = killed mid-flight; no row at all = never invoked), since Netlify answers a background function with 202 BEFORE the handler runs and the dispatcher therefore cannot observe a handler-side crash.

**The worker ACKs its invocation, so «never started» stops looking like «still working» (07/2026)**: a generation that the background function REFUSED — rejected `x-internal-secret`, missing env, a body it rejected — returns BEFORE the try block whose catch is the only code that terminalizes the row, and Netlify answers a `*-background` function with 202 BEFORE the handler runs, so the dispatcher cannot see any of it. The result was that «the worker never ran» and «the worker is still working» were the SAME observable state (status `generating`, `plan_data` `{}`) for a full fifteen minutes, after which the user got the mushy «تاخذ وقت أطول من المتوقع» rather than the truth. Worse, the 401 branch printed NOTHING — no log, no Sentry — making a secret/env mismatch the single most invisible way for generation to stop working. Fixes: (1) the handler now writes an **invocation ACK** (`plan_data: { worker_ack_at }`) after the idempotency probe and before any model call — filtered `status=eq.generating` so a duplicate invocation can never blank a finished plan, unwrapped so a worker that can't write it fails loudly, and in `plan_data` so it needs NO migration (inert while generating — `plan_data` is only Zod-parsed once status is `ready` — and the first `emit()` overwrites it wholesale); (2) `resolveStaleness` gained a rule ABOVE the 15-min branch: `generating` + no content + no ACK + older than `WORKER_ACK_LIMIT_MS` (90s, in `generationTiming.ts`) ⇒ `failed` with «لم تبدأ عملية إنشاء الخطة» and the existing retry card. `workerAcked` DEFAULTS TRUE and `getLatestPlan` derives it as "plan_data is not the empty object `createPlanRows` inserted", so a degraded read is only ever too patient and pre-ACK rows are never retroactively failed; (3) the env gate now runs BEFORE the auth gate and NAMES the missing variable — `!serviceKey` used to be folded into the 401, so the one variable whose absence stops the worker dead reported itself as «Unauthorized»; both gates now log + Sentry (`bg-env-gate` / `bg-auth-gate`, presence and lengths only, never values). Also: Phase 1's skeleton call is finally clamped to `remainingMs(deadlineMs)` like `generateDay` already was (it could burn the whole budget and be hard-killed before the first emit, and free-access mode makes households that large reachable), the terminal-write catch retries the plan row once + Sentries instead of a bare `console.error`, the dispatch enqueue-timeout path stamps `plan_generations.error_message = "enqueue unconfirmed (timeout)"` instead of recording nothing, and `INTERNAL_FUNCTION_SECRET` is documented in `env.example.txt` (it must be visible to BOTH the Next runtime and the Functions runtime — the two sides compare it directly, so a scope mismatch is a silent 401). Guarded by `generationTiming.test.ts` + `staleness.test.ts`. NOTE: the earlier theory that a stale `plan_generations` lock permanently wedges an account is FALSE — `dispatch.ts` sweeps a stale `started` row («stale generation reclassified») and proceeds.

**ROOT CAUSE of «the plan never generates» — the middleware was bouncing the worker to /auth/login (07/2026)**: `proxy.ts` matched `/.netlify/functions/*`. The app dispatches plan generation as a SERVER-TO-SERVER fetch that carries no session cookies by design (it authenticates with the `x-internal-secret` header), so `updateSession` resolved `user: null`, the unauthenticated branch redirected the dispatch to `/auth/login`, and `fetch` followed that redirect to a **200 HTML page**. The old dispatch check (`!res.ok && res.status !== 202`) accepted any 2xx, so the app recorded a successful enqueue for a worker Netlify never saw. Every generation then sat `generating` forever with NOTHING anywhere — no worker log, no Sentry event, no failed row — because nothing had run and nothing knew. Fixed in two independent layers: `.netlify` is excluded from the `proxy.ts` matcher (so the middleware is not invoked for it at all) AND an early `if (pathname.startsWith("/.netlify/")) return NextResponse.next()` guard sits at the top of `proxy()`. Guarded by `proxy.test.ts`, which pins the matcher against the exact path. Note the diagnosis order that got here, because the same trap is easy to re-enter: the dispatcher CANNOT observe the worker (Netlify answers a `*-background` function with 202 before the handler runs), so «never invoked» and «invoked and refused» look identical from the app — the discriminator was requiring exactly 202 (`dispatch.ts`, all three call sites) plus `redirect: "manual"`, which turned a followed-redirect 200 into a named error. Wrong theories ruled out along the way: a stale `plan_generations` lock (there IS a sweeper), a double slash in the dispatch URL (`env.ts` normalises it), a missing/mismatched `INTERNAL_FUNCTION_SECRET` (real hygiene issue, not this), the function not being deployed, and the Netlify plan tier (site is Pro, function was listed).

**Server Actions encryption key (ops — must stay set)**: Set `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (stable, base64 32-byte) in Netlify env for the fitlife-app-mvp site AND in local `.env.local`. Without it, Next.js generates a random server-actions key per build, so every deploy invalidates already-open tabs → saves fail with `UnrecognizedActionError: Server Action was not found on the server` (full-page error). Keep the value STABLE across deploys; rotating it breaks server actions for any open tab. Generate once with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. (Note: the repo's background `auto:` commit hook deploys frequently, which amplifies skew — a stable key is what keeps server actions working across those deploys.)

## Current Database Schema (verified 05/26/2026)

Point-in-time snapshot of the **production** `public` schema (from `information_schema.columns`).
This prose table is a human-readable reference for column names. `ARRAY` = Postgres array
(`text[]`). `nullable` maps `is_nullable` (YES→yes / NO→no).

**`database.types.ts` is now GENERATED, not hand-maintained.** Regenerate it from the schema
with `pnpm --filter @fitlife/app db:types` (runs `supabase gen types typescript --local`) — do
NOT edit `apps/app/src/lib/supabase/database.types.ts` by hand. The generated file is the typed
source of truth used by the code; the snapshot below is just documentation.

### family_members

| column_name | data_type | nullable |
| --- | --- | --- |
| id | uuid | no |
| user_id | uuid | no |
| name | text | no |
| role | text | no |
| birth_year | integer | yes |
| weight_kg | numeric | yes |
| height_cm | numeric | yes |
| activity_level | text | yes |
| primary_goal | text | yes |
| preferred_language | text | no |
| dietary_restrictions | ARRAY | yes |
| medical_conditions | ARRAY | yes |
| display_order | integer | no |
| created_at | timestamp with time zone | no |
| updated_at | timestamp with time zone | no |
| member_type | text | no |
| sex | text | yes |
| consulted_doctor | boolean | yes |
| allergies | jsonb | yes |
| dislikes | jsonb | yes |
| trimester | integer | yes |
| months_postpartum | integer | yes |
| high_risk_pregnancy | boolean | yes |
| school_meal_handling | text | yes |
| picky_eater | boolean | yes |

### meal_plans

| column_name | data_type | nullable |
| --- | --- | --- |
| id | uuid | no |
| user_id | uuid | no |
| status | text | no |
| generated_at | timestamp with time zone | yes |
| error_message | text | yes |
| plan_data | jsonb | yes |
| ai_model | text | yes |
| ai_input_tokens | integer | yes |
| ai_output_tokens | integer | yes |
| ai_generation_seconds | numeric | yes |
| created_at | timestamp with time zone | no |
| updated_at | timestamp with time zone | no |

### plan_generations

| column_name | data_type | nullable |
| --- | --- | --- |
| id | uuid | no |
| user_id | uuid | no |
| meal_plan_id | uuid | yes |
| ai_input_tokens | integer | no |
| ai_output_tokens | integer | no |
| estimated_cost_usd | numeric | no |
| status | text | no |
| failure_reason | text | yes |
| created_at | timestamp with time zone | no |
| model | text | yes |
| tokens_in | integer | yes |
| tokens_out | integer | yes |
| cost_usd | numeric | yes |
| duration_ms | integer | yes |
| error_message | text | yes |
| started_at | timestamp with time zone | no |
| completed_at | timestamp with time zone | yes |

### profiles

| column_name | data_type | nullable |
| --- | --- | --- |
| id | uuid | no |
| display_name | text | yes |
| preferred_language | text | no |
| birth_year | integer | yes |
| weight_kg | numeric | yes |
| height_cm | numeric | yes |
| activity_level | text | yes |
| primary_goal | text | yes |
| cuisine_preference | text | no |
| dietary_restrictions | ARRAY | yes |
| has_medical_conditions | boolean | no |
| medical_conditions | ARRAY | yes |
| is_pregnant | boolean | no |
| pregnancy_trimester | integer | yes |
| consulted_doctor | boolean | no |
| onboarding_completed_at | timestamp with time zone | yes |
| created_at | timestamp with time zone | no |
| updated_at | timestamp with time zone | no |
| sex | text | yes |
| member_type | text | no |
| allergies | jsonb | yes |
| dislikes | jsonb | yes |
| months_postpartum | integer | yes |
| high_risk_pregnancy | boolean | yes |
| family_dietary_restrictions | jsonb | yes |
| family_dislikes | jsonb | yes |
| cooking_methods | jsonb | yes |
| meal_out_frequency | text | yes |
| family_wide_completed_at | timestamp with time zone | yes |
| mom_profile_completed_at | timestamp with time zone | yes |
| member_addition_order | jsonb | yes |

### subscriptions

Both the legacy `ls_*` columns (+ `billing_interval`) and the 00004 `lemonsqueezy_*` (+ `cadence`,
`trial_started_at`, `cancel_at_period_end`) columns coexist. Current code reads/writes the
`lemonsqueezy_*` + `cadence` set; the `ls_*` + `billing_interval` columns are legacy.

**00024 added `unique (user_id)`** — there is now exactly ONE row per user. The read path had
always assumed it (`order created_at desc limit 1`) while the webhook wrote to every row a user
held, so the two disagreed the moment a second row existed. **`last_event_at`** (also 00024)
holds `attributes.updated_at` of the most recent LemonSqueezy webhook applied; events at or
before it are ignored as replays / out-of-order delivery.

| column_name | data_type | nullable |
| --- | --- | --- |
| id | uuid | no |
| user_id | uuid | no |
| ls_subscription_id | text | yes |
| ls_customer_id | text | yes |
| ls_variant_id | text | yes |
| ls_order_id | text | yes |
| tier | text | no |
| status | text | no |
| billing_interval | text | yes |
| current_period_start | timestamp with time zone | yes |
| current_period_end | timestamp with time zone | yes |
| trial_ends_at | timestamp with time zone | yes |
| cancelled_at | timestamp with time zone | yes |
| ends_at | timestamp with time zone | yes |
| created_at | timestamp with time zone | no |
| updated_at | timestamp with time zone | no |
| cadence | text | yes |
| trial_started_at | timestamp with time zone | yes |
| cancel_at_period_end | boolean | no |
| lemonsqueezy_subscription_id | text | yes |
| lemonsqueezy_customer_id | text | yes |
| lemonsqueezy_variant_id | text | yes |
| last_event_at | timestamp with time zone | yes |

---

## What a ten-step live test of a six-person household changed (08/2026)

Driven as a real customer on production, one account grown from solo to the family cap
(هند + husband, a 10-year-old, a 16-year-old, a grandmother, and a Tagalog-reading
housekeeper). Everything below was found by using the product, not by reading it.

**The advisor invented a day's menu.** Asked «الكبار بس — وش عندهم اليوم؟» during a
regeneration it produced a full day of named dishes for two adults, none of which
existed — while four other questions in the same two-minute window correctly answered
that it had no meal details. The context was the invitation: `planSummary` SKIPPED empty
days, so a week with nothing in it rendered as a member header with targets and no
dishes, a shape that reads as "not mentioned" rather than "not generated". It now says
when the plan is generating and NAMES the days that have no meals yet, so there is no
silence to fill. Two related rules were added at the same time: a number is re-read from
its own owner's line when the subject changes (it had carried سعود's 75g protein onto
لمى across a «وأختـه؟» turn), and an uncomputed target means "not yet", not "no need"
(a member mid-skeleton was reported as «هدف 0 سعرة» with advice to generate a plan,
during a generation).

**Superlatives were guesses.** On a six-person roster «الأصغر» returned the 16-year-old
and «الأكبر» returned the 10-year-old — the youngest given as the oldest — while the same
conversation could recite both ages correctly when asked about twins. Having the numbers
and comparing them are different things. `ageOrderLine` (contextFormat.ts) now states the
household youngest→oldest with ages and names the youngest and oldest outright; anyone
without a birth year is listed separately rather than silently sorted to an end.

**The housekeeper's translation had no retry.** A maid added with Tagalog mid-generation
got nothing: no translated meal, no housekeeper view, no signal. Two paths hand this to
each other and BOTH can decline — `triggerPlanTranslation` no-ops while a generation is
live on the stated assumption that "the freshly-generated plan lands already translated",
and the generation only translates if budget remains after its day loop, which at five
beneficiaries it routinely does not. `drainDeferredMembers` now finishes a pending
translation once no member needs generating, judging "pending" from the meals themselves
so a half-translated week is seen as unfinished.

**Then: the cook stopped being last in the queue (08/2026).** The retry above still
waited for the WHOLE household — three separate gates, all `hasPendingGeneration`:
`triggerPlanTranslation` would not start, the generation's end-of-run pass would not run,
and `housekeeper/page.tsx` rendered her waiting card INSTEAD of the plan. At the 6-member
cap, where a run yields ~2 of 7 days, that meant four members could have complete
translated weeks while the one person who cannot read the Arabic view — and who does the
actual cooking — saw a spinner, waiting on other people's days that she does not need to
make tonight's dinner. All three gates are gone. Translation now runs on whatever exists:
`translateMealPlan` skips meals already carrying the locale, so the token total is
IDENTICAL either way and only the number of passes grows. `preparing` now means "nothing
cookable exists at all"; `partialWeek` is a NOTICE above a usable plan (new `partial_week`
string in all 7 locales; `awaiting_family` was reworded — it promised translation would
begin "once they're ready", which stopped being true). PlanViewer already renders partial
data correctly (a day appears only once every recipe in it carries her locale), so nothing
shows half-done. Guarded by `housekeeperWaiting.test.ts`.

**That made a latent race reachable, so translation now takes the lock.** Generation and
translation each persist the WHOLE `plan_data` blob from their own in-memory copy, so
interleaved they erase each other — a translated day vanishes, or a freshly generated one
does. They were previously kept apart only by translation refusing to start until
generation was completely finished. `runMealPlanTranslation` now opens its
`plan_generations` row as **`'started'` BEFORE touching plan_data** and closes it
`completed`/`failed`, instead of inserting it `'completed'` at the end — so 00014's
`(user_id, plan_kind) where status='started'` unique index refuses the overlap at the
DATABASE rather than us hoping to detect it. A `23505` conflict means someone else holds
it: skip the pass entirely (no model call, no write). A non-concurrency insert failure
still translates unlocked — a broken audit row must not block the maid. The 25-second
`TRANSLATE_INFLIGHT_SEC` heuristic it replaces is deleted; a hard-killed pass is recovered
by the existing staleness sweep. Guarded by `translationLock.test.ts`.

**`stripMarkdownFence` corrupted every unfenced translation reply.** Found while writing
the test above. Its own comment asserted "callers all expect a single JSON OBJECT (day
slice, skeleton, translation)" — but BOTH translation schemas are arrays, the only
array-shaped payloads in the codebase. The unfenced fallback sliced from the first `{` to
the last `}`, so `[{…},{…}]` became `{…},{…}` (not JSON at all) and a single-element
`[{…}]` became a bare object that then failed the array schema. Either way the day was
left untranslated behind a `console.warn`, so whether the housekeeper got her recipes came
down to whether the model happened to fence that particular reply. It now picks whichever
bracket opens the payload and closes with its match; object payloads (which start with `{`
even when they contain arrays) are byte-for-byte unchanged.

**The advisor cap was 30/day for a WHOLE HOUSEHOLD.** Measured: 30 messages cost $0.352,
about $0.012 each. So it bought ~35 cents/day of protection while rationing the flagship
feature — at six people that is five messages each, and a single tester exercising one
feature exhausted a family's allowance. Now 100, env-overridable via `CHAT_DAILY_CAP`.
The 429 body also used to say «يرجى المحاولة غداً», wrong twice: the window is ROLLING
(the first slot returned 80 minutes later, not at midnight) and the pool is shared. It
now names both and counts down to the next free slot.

**Deleting a member said the wrong thing.** The confirmation read «بنعيد تنسيق خطط
العائلة بعد الحذف» — a scheduling note — while the action is immediate, irreversible, and
purges the member's `meal_checkins`, `meal_verdicts`, `workout_checkins`, `meal_absences`
and `body_logs`. Verified: no undo, no toast, no grace period. The dialog now says
permanent, and says the records go too.

**A 16-year-old was described to the model as a 10-year-old.** `CHILD_AGE_CUTOFF = 18`
puts both in one portions bucket, and measured across four regenerations the 16-year-old
boy (58 kg, 168 cm) came out at 994, then 875, then 560, and finally **985 kcal — the
exact same figure as his 10-year-old sister (33 kg)**. Their ages and weights were in the
roster; the only sentence that said how to FEED either of them was «طفل — بالحصص، بدون
هدف سعرات», identical for both, so the model had one bucket and used it. The
methodology already distinguishes them — its own family-portion example splits «المراهق:
540 جم (30٪)» from «الطفل: 180 جم (10٪)» of one pot — it just had no way to tell which
one it was looking at. So `minorStage` (childRule.ts, `ADOLESCENT_AGE_MIN = 13`) now
drives one shared clause (`minorClauseAr` in systemPrompt.ts) used by the owner roster
line, the member roster line and the day prompt: it states the stage AND the actual age,
and points the portion at that person's own age/weight/activity/growth stage. The
skeleton instruction additionally forbids giving two minors of different ages the same
estimate. **This sets no calorie number and does not touch the no-BMR/TDEE rule** — a
minor of any age is still planned by portions; what changed is that a sixteen-year-old
stops being described as a ten-year-old. The 13 boundary is a LABEL boundary (it matches
step1Schema's signup floor), not a nutrition cliff: the clause carries the real age, so a
twelve-year-old is scaled to twelve either way. Verified on production against the same
household: the five days regenerated after the fix put سعود at 1260-1500 kcal against
لمى's 780-880 off the SAME dishes, while the two days carried from before it still show
the old shape (الثلاثاء: سعود 705, لمى 880 — the sixteen-year-old eating less). Guarded
by `minorStage.test.ts`.

**CORRECTION (08/2026).** This section previously closed by saying both minors still
landed near HALF the intake general references give, and that "that is the portions path
itself, not the age labelling". **That was measured on runs that went through the
scoped-regen path, which skipped the calorie band entirely** (see the section below), so
the whole pot was low and the children's shares with it. On the first clean
full-household run after that fix, سعود came out at **1950** (from 985) and لمى at
**1035**, with all three adults exactly on target. Minors are exempt from the band, so
the correction reached them the only way it could: their portions are shares of the same
batch, and the batch was wrong. **What remains for Coach Sara is a smaller, honest
question** — 1950 for a 16-year-old boy at 58 kg and 1035 for a 10-year-old girl at 33 kg
are still on the low side of general references — plus whether an adolescent belongs in
the portions model at all. It is no longer a claim that the model under-feeds every minor
by half.
Note this edits `SARA_METHODOLOGY`, so the cached static prompt block invalidates once on
deploy.

---

## Three things a household could not do (08/2026)

All found by using the app as a customer, all in the regeneration path.

**There was no way to ask for a fresh week for the FAMILY.** Both `RegenerateButton`
mounts in PlanViewer pass the viewed member's id, and the dashboard's «أنشئي خطة جديدة
لأسبوع جديد» is a plain `<Link href="/plan">`. `/api/plans/generate` has always treated a
missing `memberId` as a full regen — nothing ever sent one, so a customer could
regenerate people one at a time and never the household. The scope chooser gained a
fourth option, **«البيت كله»**, which is simply the ABSENCE of a member scope in the POST
body; the dialog title follows the choice so it stops saying «لـ سعود» once the household
is selected. The chooser now shows whenever `memberId && memberCount > 1` (it was
`memberId && hasSharedMeals`, so a member with no shared meals had no chooser at all);
on a solo plan there is still none, because the only member IS the household.

**A busy regeneration was silently swallowed.** `DeferredMemberDrain` mounts on /plan AND
/dashboard and dispatches IMMEDIATELY, taking the per-kind lock for the whole 5-15 minute
run. So on a household whose week never fills — the state the drain exists for — the
user's own «إنشاء خطة جديدة» reliably 409s, and the handler did `closeDialog();
router.refresh()`: the tap did nothing and said nothing. It now keeps the dialog open,
states that a run is in progress, and leaves the confirm button live to retry (the page
is already polling, so the retry succeeds as soon as the run ends). **The underlying
contention is NOT fixed** — one meal run at a time is a real constraint and a background
function cannot be preempted; what changed is that the product no longer lies about it.

**A regeneration took the cook's plan away.** `triggerPlanGeneration` inserts an EMPTY
`meal_plans` row that immediately supersedes the translated week, so from the moment
anyone taps regenerate the housekeeper loses the plan entirely for the length of the run —
with no Arabic view and no readable history to fall back on. `getCookablePlan`
(getLatestPlan.ts) returns the newest plan that actually has meals in it, plus a
`superseded` flag; her page reads THAT (`getCurrentUserCookablePlan`) and shows the new
`previous_week` line above the week she can still cook from. Deliberately scoped to her
page: for the owner a generating screen is the right answer, because she asked for it and
the progress is the information. Guarded by `regenScope.test.ts`.

---

## A scoped regen skipped the calorie band entirely (08/2026)

Found by regenerating one member on production and reading the result. `«إنشاء خطة
جديدة»` on a member tab rewrote five of seven days, and the whole household came out at
roughly HALF its targets — a 3865-kcal adult on 1880-2230, a 1472-kcal adult on 720-940 —
while the two days that run did not touch stayed at 3785-4045 and 1190-1230. Both the
per-day band re-roll AND the deterministic rescale were behind `if (!partialScope)`, so a
scoped regen wrote whatever the model returned.

The comment's premise was right and its conclusion backwards: under a partial scope the
slice's own sum genuinely is not the member's day — but the answer is to add the other
half in, not to stop checking. **The band now runs on the PROJECTED day**: the
out-of-scope meals carried verbatim from the stored plan (`carriedTotals`) plus only
those fresh meals that land in an in-scope position (`projectedSlice()`, rebuilt with the
same `extractInScopeFresh` the splice itself uses — the model returns a WHOLE day even
under a partial scope, so part of the slice is discarded and must not be counted). The
rescale still scales the real slice, with the factor computed in fresh-meal space
(`target − carried`) so the spliced day lands exactly on target; when the carried meals
alone already reach the target no factor can help, and that is logged rather than scaled
to a nonsense number.

Note the reach: the regenerate dialog **defaults to scope `"both"`**, and `"both"`/
`"shared"` pull in every co-sharer, so on a shared-meal household one tap put nearly
everyone through the unchecked path. Guarded by `partialScopeBand.test.ts`; the two
partial-scope fixtures in `generate.test.ts` were rebalanced to be genuinely in band
(they never were — the skip is why nobody noticed).

---

## The background function was a SECOND copy, and it had drifted (08/2026)

Found while adding the housekeeper's sex question. `apps/app/netlify/functions/
generate-plan-background.mts` imports `generateMealPlan` from the engine — so the day
loop, the calorie band, the budget clamps and the salvage are genuinely shared — but it
MIRRORS `runMealPlanGeneration`'s orchestration, and translate mode had its own copy of
the translation logic entirely. Consequences, all live in production while the engine
looked fixed:

- **The end-of-run pass still waited for the whole household.** The `!stillGenerating`
  gate was removed from the engine (so the cook stops being last in the queue) and left
  in place here, which is the path production actually takes.
- **Neither translation path was bounded by the run deadline**, so the hard-kill window
  described above was never actually closed for production.
- **Translate mode never took the generation lock** — `runMealPlanTranslation` opens a
  `'started'` row, but this branch inserted its own `'completed'` row at the end, so the
  race that lock exists to prevent was still reachable.

Translate mode now CALLS `runMealPlanTranslation` instead of reimplementing it, which
took extending the SDK-free `makeFetchSupabase` shim with `insert().select().maybeSingle()`
(carrying PostgREST's `code` through, since `23505` is what tells the caller someone else
holds the lock). The end-of-run branch keeps its own shape — it is inside the run — but
now passes `deadlineMs` and drops the household gate, matching the engine. **When changing
`runMealPlanGeneration`, check this file: it is the production path.**

---

## The regeneration that was deferred to nobody (08/2026)

Found while verifying the July audit's three unverified leads. **Two do not reproduce**:
the family/member wizards ARE gendered throughout (every feminine string sits inside a
`genderPick` call), and member edits DO reach `runFamilyGeneration` from the edit UI. The
third is real, and tracing it turned up a worse one.

`updateFamilyMember` regenerates on a substantive edit — unless a run already holds the
lock, where it returned `{ ok: true, plan_generation_id: null }` under a comment saying
"Current plan still generating → edit is saved; defer the regen." **Nothing deferred it.**
The drain only picks members with MISSING days, and an edited member still has all seven
(stale) ones, so the regeneration was silently dropped; `MemberWizard`'s
`if (!result.plan_generation_id) router.push("/plan")` — commented "(e.g. cosmetic edit)"
— then sent her to the plan as though it had worked. That is precisely the failure
`memberEditIsSubstantive` was written to prevent («adding a nut allergy to a child saved
the row and left the nut-containing plan on screen»), reachable again through a busy
window that every /plan and /dashboard visit opens, since `DeferredMemberDrain` dispatches
on mount.

`staleMemberIds` (memberEdit.ts) compares `family_members.updated_at` against the plan's
`generated_at`, and the drain regenerates the first stale member once nobody is missing a
day. No new column and no marker: a completed regeneration clears the signal by
construction, because the new plan is then the newer of the two, which also makes it
impossible to loop. A null `generated_at` means the plan has never finished building, so
the run in flight covers it. The housekeeper is excluded (never a beneficiary). Cost of
the approximation: a rename made DURING a live run buys one extra regeneration — a rare,
bounded price for never leaving an allergy edit unapplied. `LatestPlanSummary` gained
`generated_at` for this. Guarded by `memberEdit.test.ts`.

**Still open from the same lead:** `«تعليمات طبخ بلغة الخدامة»` is listed as a `family`-tier
feature (129 SAR/mo) in `packages/config/src/pricing.ts`, but the only gate on adding a
housekeeper is `canAddHousekeeper={!housekeeper}` — no tier check anywhere, and she does
not consume a beneficiary slot (`.neq("role", "housekeeper")`). So a `starter` subscriber
gets the translated cooking view. `«لوحة موسم بيتنا للعائلة»` is listed family-only on the
same page and is reachable on `pro` for the same reason. Whether to gate the features or
move the lines is a PRICING decision, not an engineering one — left for the owner. Moot
while free-access mode is on.

---

## The cook was measuring the wrong amounts (08/2026)

When a sharer is marked out of one occurrence, the batch scales down to the remaining
sharers — deterministic display math over `per_member_portions`, the stored plan
untouched. `MealCard` applies it only when given `absentMemberIds`, and
`housekeeper/page.tsx` never read `meal_absences`. So mom saw the adjusted amounts on
/plan and the kitchen went on cooking for the full household. The housekeeper page now
does the same calendar-keyed read /plan does (a plan-id read goes empty mid-week, since
every dispatch mints a new `meal_plans` row) and passes `absences` through; she gets the
scaling but not the toggle, because `canToggleAbsence` already requires `!readOnly`.
Degrades to `[]` on any error, which is exactly the previous behaviour.

The explanation line beneath the numbers was gated on `!translated` — excluding the one
reader actually measuring the ingredients — under a comment saying it existed "so the
cook never wonders why today's amounts differ from the plan". New `meal_adjusted_for`
string in all 7 locales; the Arabic view is unchanged. Guarded by
`housekeeperAbsence.test.ts`. The PDF export now scales too: its per-meal ingredient
amounts were always the member's OWN portion and so were never wrong, but the batch total
and the list of who is sharing came straight from the stored plan — a printed sheet that
overstates the amount and names someone who is not eating. `PlanViewer` passes its
`absenceSet` through `DownloadPDFButton`. **Still unscaled: /plan/history, deliberately —
it is a record of what was planned, not an instruction to cook.**

---

## One day of seven for $2.81 — the day-loop budget (08/2026)

Measured on production, a 5-beneficiary household, twice: 11.3 minutes, ~178k OUTPUT
tokens, and **one usable day**, with the rest lost to `Anthropic stream timeout after
202876ms`. Three separate causes, all arithmetic.

**The reserve was one day call; it needed to be the loop's shape.** The clamp added in
"Phase 1 must leave room for phase 2" (below) let the skeleton run until
`DAY_CALL_ESTIMATE_MS` remained — which guarantees a single day *could start*, not that a
WEEK can be built. `dayLoopReserveMs(days, concurrency)` = `ceil(days/concurrency)` waves
× a typical day. Deliberately the ESTIMATE, not `bigCallTimeoutMs`'s worst-case bound:
reserving the worst case at five members exceeds the whole function budget and starves
phase 1, which is the same bug pointing the other way.

**The skeleton borrowed the day loop's ceiling.** Both phases used
`bigCallTimeoutMs`, sized for a day of full recipes (450s at 5 members) — but the
skeleton emits dish NAMES and one target block per member, a few thousand tokens. A
ceiling is what a slow call expands to fill. `skeletonTimeoutMs(memberCount)` now tracks
phase 1's own work (270s at five members, capped 360s).

**The smaller translation reserve created a hard-kill window — fixed.** The end-of-run
translation pass was gated ONLY on having `MIN_VIABLE_CALL_MS` (45s) to START, after
which it ran a sequential member × day loop of 240s-default calls with no bound at all.
With the old 180s reserve that was survivable; with 60s it was not. Measured immediately
after the change: a run at **1001s against a 900s budget**, still `'started'`, one day
written, the plan's last write three minutes earlier — the function hard-killed before its
terminal write. That leaves `plan_generations` stuck at `'started'`, and under 00014's
`(user_id, plan_kind) where status='started'` unique index it **blocks every future meal
generation for that user** until the staleness sweep clears it fifteen minutes later.
`translateMealPlan` now takes `deadlineMs`: it breaks out of the member and day loops when
`!canFit(deadlineMs, MIN_VIABLE_CALL_MS)`, and each call's timeout is
`boundedCallTimeoutMs(TRANSLATE_CALL_TIMEOUT_MS, deadlineMs)`. That helper deliberately
does NOT floor its result — flooring is exactly how a call overshoots (given 10s of
budget, a 45s floor spends 35s the finalize reserve was holding); refusing to start is the
caller's job. Both call sites pass a deadline, including the standalone
`runMealPlanTranslation`, whose own row would otherwise wedge the household's next MEAL
run.

**`TRANSLATION_RESERVE_MS` 180s → 60s.** Its own comment said over-reserving cost "at
most a deferred day" while under-reserving cost the whole pass. Both halves stopped being
true: translation now runs on a PARTIAL plan, her page re-triggers it, the drain finishes
it, and `runMealPlanTranslation` takes the lock — so a skipped end-of-run pass costs
minutes, not the feature. Meanwhile 180s was a quarter of a day loop that was delivering
one day of seven.

**A call cut off at 95% cost 100%.** Six day calls streamed ~25k tokens apiece and were
discarded whole — about $2.40 of the $2.81. `AnthropicCallError` now carries
`partialText` on a mid-stream abort; `salvageTruncatedJson` (anthropic.ts) walks it once
(string/escape aware, so a `{` in a recipe name is not structure), cuts after the last
element that CLOSED while still nested, and appends the open closers. **The cut point had to be an ELEMENT boundary, and the first version got it wrong** — it
cut after the last bracket that closed while merely *nested*, which in practice is an
ingredient object deep inside a half-written meal. That yields structurally-valid JSON
describing a meal with no steps, calories or macros, which then fails the schema and takes
the whole rescue down with it; measured on production, the rescue returned null on every
one of six timed-out days. It now tracks the depth of the OUTERMOST array and cuts only
when a direct element of it closes, so every element that survives is whole by
construction. `rescueDaySlice` (generate.ts) then keeps **only members whose meal count
matches what the skeleton planned for that day** — that strictness is the safety argument, because a member cut off with two
of four meals would be handed to the calorie rescale and scaled to a full day's target,
producing absurd portions. Unverifiable members are dropped and the drain refills them,
which is what would have happened to all of them anyway. The rescued slice re-enters the
day loop as if the model had just returned it, so it gets the same band, rescale and
assembly enforcement as a live one; its token counts read 0 because an aborted stream
never delivers the usage event (the spend was already billed on the call that died).

Guarded by `dayBudget.test.ts`, which asserts the BEFORE/AFTER directly: at five members
the old arithmetic left the day loop less than one wave, the new leaves it more.

**Measured after the above: 4 of 7 days for $3.28** (was 1 for $2.81) — 4× the output for
17% more spend, cost per usable day $2.81 → $0.82, and every adult on target on every day
written. Two follow-ups from that run: (a) the three days still lost were 1, 3 and 6 — NOT
a contiguous second wave, because `mapWithConcurrency` is a rolling pool, so whichever
days start late inherit whatever budget is left. The start gate was a flat
`DAY_CALL_ESTIMATE_MS` (150s, measured on 4-member runs and the optimistic end of that
range), so a 5-member day was allowed to begin with 205s against ~450s of work; it
streamed ~25k tokens and died, three times, ~$1.13 of the run. `dayCallEstimateMs`
(budget.ts) now sizes that gate to the day's OWN ceiling (0.6×, floored at the flat
figure so small households are untouched) — **and EVERY gate uses it, not just the first**.
Fixing only the start gate left the three retry gates (API-transient, content re-roll,
band re-roll) on `MIN_VIABLE_CALL_MS`/`DAY_CALL_ESTIMATE_MS`, so a re-roll could still
begin with ~50s against 450s of work: measured on the next run, four days died at
`Anthropic stream timeout after 75446ms` — 75-SECOND calls, ~$2 of a $3.32 run, all of it
spent by retries the start gate had already refused once — a doomed call is worse than no call, since a
deferred day costs nothing and the drain refills it. Deliberately NOT applied to
`dayLoopReserveMs`: the reserve answers "how much must phase 1 leave", and making that
pessimistic too would starve the skeleton. (b) **The salvage did not visibly fire** — all
four days that landed carried the full member set, so `rescueDaySlice` returned null every
time. Whether that is "nothing whole had streamed" or "the strict meal-count match rejected
it" was unanswerable from the database, so the recorded day error now says which —
`(no partial output)`, `(salvage: nothing whole streamed)`, or `(salvage: no complete
member)`. The first measurement reported the last of those while the real cause was the
first, because two outcomes shared one message; they point at completely different fixes
(call length vs match strictness), so they are now distinct; `plan_generations.error_message`
is the only diagnostic that leaves the function.

**The drain now finishes the week in ONE round, not one per member.** At five members,
skeleton + two waves is ~20 minutes of work against a 15-minute platform budget, so a
single run cannot build a whole week — that part is structural and stands. What was
fixable is what happened next: `pickNextMemberId` returns ONE member and the run targeted
only them, so a week that stopped at 4/7 for the whole household needed five separate
invocations, each waiting on a page visit to dispatch and each holding the generation
lock. The engine has always supported the better shape — `membersToGenerate` is
`beneficiaries.filter((b) => !isComplete(b))` whenever no `onlyMemberId` is given, so a
carry-over run with no member scope fills EVERY incomplete member — and because members
already in the plan carry their targets from it, such a run makes no skeleton call at all:
day calls only, same total tokens, one invocation instead of five. `incompleteInPlanMemberIds`
(drainScope.ts) is the predicate; the drain uses the wide run only when >1 member is short
AND all of them are already in the plan (an ABSENT member still needs a skeleton, and a
shared newcomer still needs `regenerateSharedGroup`). Guarded by `drainScope.test.ts`.

`PLAN_DAY_CONCURRENCY=7` (env, no deploy) would collapse the two waves into one and
remains the cheapest untried experiment; the default stays at 4/5 because 7 simultaneous
calls tripped 429s when the day model was Haiku, and that has not been retested on Sonnet.

---

## Phase 1 must leave room for phase 2 (08/2026)

Sentry bfda604f, production, a 3-member household: `PlanValidationError: All 7 day
generations failed — deferred: run budget spent before this day started (no model call
made)`. The run spent 856s and $0.46 and produced ZERO days.

`bigCallTimeoutMs` sizes the SKELETON call to the work (280s at 3 members, up to 600s)
and knew nothing about the 15-minute run deadline — and the max_tokens truncation retry
can run it a SECOND time at double the cap. So phase 1 could legitimately spend the whole
box and hand the day loop a budget it had already exhausted; the loop then correctly
deferred all 7 days. The skeleton timeout is now clamped to
`remaining - DAY_CALL_ESTIMATE_MS` (floored at `MIN_VIABLE_CALL_MS`), and the truncation
retry is refused unless a second call AND a day call still fit. Guarded by
`skeletonBudget.test.ts`.

**Consequence worth knowing: an empty run used to destroy a working plan.** Adding a
third member triggers a full shared-group rebuild (`prepareSharedGroupRegen`), so nothing
is carried; when that run came back empty it was written `failed`, and being the NEWEST
row it replaced a complete 7/7 week with an error screen on /plan and /dashboard. The
good plan was never deleted, only shadowed — and since `DeferredMemberDrain` requires
status "ready", the household could not self-heal either. `getLatestPlan` now reads a
WINDOW of 5 rows and, when the newest is failed-with-no-content, scans back to the most
recent ready plan that actually has meals. The window is 5 rather than 2 because failures
STACK — the account this was found on had two consecutive empty runs (the original and
the user's retry), which put the last good week third, so a one-row-back fallback found
another failure and gave up. A stale week beats an error screen, and it keeps the drain's
precondition satisfiable. Guarded by `previousPlanFallback.test.ts`.

---

## Stored enums must reach a prompt as Arabic RULES (08/2026)

Found by driving the deployed app as a real user (Riyadh household, `lactose_free` +
`ibs`). Three surfaces were handing the model — or the customer — a raw database
value, and one was missing the data entirely.

**A dietary restriction is a RULE, not a label.** `describeMom`/`describeMember`/
`familyWideText` rendered `قيود غذائية: lactose_free.` — an English snake_case token
dropped into an Arabic prompt with NO directive, while the allergy line directly
beneath it carried an explicit «تجنّبيها تماماً». The generated week for that account
then served لبنة on three days plus جبن قريش and موزاريلا, none of them lactose-free,
with notes recommending لبنة on health grounds — and the advisor chat, reading the SAME
profile, correctly told the same user that ordinary لبنة was not safe for her. The two
AI surfaces contradicted each other because only one was told what the token forbids.
`RESTRICTION_RULES_AR` (systemPrompt.ts) now names each restriction in Arabic AND lists
what it rules out in the ingredient vocabulary the plan is written in, with Gulf staples
called out by name (لبنة، جريش، برغل، فريكة، مرقوق، ساوردو) because that is what the
cookbook reaches for by default. Unknown values pass through verbatim — a constraint is
never silently dropped. Guarded by `dietaryRestrictions.test.ts`.

**The condition catalogue moved INTO the engine.** The same line rendered «تعاني من: ibs».
The Arabic labels existed, but only in `apps/app/src/lib/plans/medicalConditions.ts`,
which the engine cannot import. `packages/plan-engine/src/medicalConditionLabels.ts` is
now the single catalogue and the app file re-exports it, so wizard chips and prompt text
cannot drift — the failure mode this repo already hit once when the UI chip roster and
the engine's gate list diverged by a slug.

**The advisor could not answer a calorie question for anyone.** `buildHouseholdContext`
shipped goal/cuisine/allergies/restrictions/conditions but NOT `birth_year`, `weight_kg`,
`height_cm`, `activity_level` or `sex` — for the owner or any member. So «كم سعرة أحتاج؟»
was answered by asking the user to re-type her age, height, weight and activity level,
all four of which she gave during onboarding and all four of which /profile shows back to
her. It also had no date at all: the plan summary lists day NAMES only, so «وش تاكل اليوم؟»
and «وش تاكل بكرة؟» returned the SAME day, and the wrong one. `contextFormat.ts` (pure,
split out of the `server-only` module so it is testable) adds both, in Riyadh time, plus
Arabic labels for every enum. Guarded by `contextFormat.test.ts`.

**Onboarding resumes where the data stops.** `saveProfileStep` persisted the first
steps and `restoreAnswers` read them back, but `MomWizard` always mounted at index 0 —
refreshing at step 8 of 11 dropped the user to «1 / 10» with her answers pre-filled and
ten screens of clicking to return, on the app's biggest drop-off surface.
`initialStepIndex` (in `restoreAnswers.ts`, the pure module, so the test does not import
the client component into a node-environment suite) resumes at the first step whose data
is NOT provably saved. It stops at `goalActivity` by design: `primary_goal` is stored
SARA-mapped at final submit, so there is nothing after it to resume from.

**Generation timing copy matched no observed run.** `/plan` promised «من دقيقة إلى
دقيقتين» and the dashboard «خلال دقيقة تقريباً»; measured on production, a one-member
week took 9 minutes and a two-member week 12, so every real run overran its own estimate
by 5x and read as stuck. Now «من خمس إلى عشر دقائق», and it says she may close the page
— which was always true (the work is a background function) and is the more useful fact.

**«تفاصيل تقنية» disclosed nothing.** `resolveStaleness` fell back to the exact sentence
the failure screen already shows as body copy, so expanding the disclosure repeated what
the user had just read — in the one state that has no other signal, because the worker
never wrote a row. The fallback now describes the stall, and `PlanFailedState` hides the
disclosure entirely when it would duplicate the body.

**The chat renders PLAIN TEXT.** `ChatPanel` puts the reply in a `whitespace-pre-wrap`
div with no markdown renderer, and the model was emitting `**bold**`, `##` headings and
pipe tables — which customers saw as literal syntax. The chat system prompt now forbids
markdown, emoji and exclamation marks (the last two were already against the house tone
rules) and pins the dialect to Saudi Gulf, after «فطورج» — an eastern-Gulf/Kuwaiti form —
reached a Riyadh user.

---

## Engineering audit + fixes (07/31/2026)

A read-only audit of the whole codebase (auth, family, payments, generation, engagement,
DB contract, UX paths) produced 53 confirmed findings; the fixes shipped in six commits on
`claude/fitlife-engineering-audit-e4yq9j`. Full report with per-finding evidence lives in the
session's plan file. **Migration 00024 carries the DB half and is applied.** The recurring
patterns are worth knowing before touching any of this code again.

**The three root causes.** (1) RLS policy sets missing the verb the app actually uses — a
DELETE with no policy affects zero rows and returns NO error, so the action reports success
and the row survives; this shipped twice. (2) THE SAME RULE IMPLEMENTED TWICE with one copy
drifted — the per-kind generation lock, the two variant resolvers, `isAdult` vs `isAdultLike`,
the two family builders. (3) State written BEFORE it was validated, so the account could
reach a place the product had no exit from.

**Generation lock is PER KIND.** `plan_generations` queries MUST filter `plan_kind`. 00014
replaced the one-run-per-user lock with `(user_id, plan_kind)` so a meal run and a workout run
may coexist; the meal-side busy guard and `triggerPlanTranslation` did not honour it, so a
live workout run (which waits up to 8 min for meals BY DESIGN) made every meal dispatch report
`busy` — "new plan" did nothing, add-member silently deferred, translation skipped. Same for
the stale reclassifiers, which could otherwise flip a live workout's audit row to `failed`.

**`plan_generations` is an AUDIT table.** 00024 dropped the user UPDATE policy (the browser
could reset its own weekly quota, clear the in-flight lock, and rewrite the `cost_usd` columns
the admin dashboards aggregate). INSERT stays — `createPlanRows` opens the row with the user's
client. **Every UPDATE must use the service-role client**, including the dev-inline generation
path, which now passes `createAdminClient()` exactly as the prod background function always did.

**Tier limits are enforced AT THE BOUNDARY (owner directive 07/2026).** `addFamilyMember`
checks the person count BEFORE the insert and returns `upgrade_required` without writing;
`/api/subscription/change` refuses a downgrade that would strand members, before calling
LemonSqueezy. `countBeneficiaries` returns `null` on a query error and callers FAIL CLOSED
(`count_unavailable`) — it used to return 1, which for a limit check is the best case, not
the worst, so any DB blip silently removed the limit. **But the generation gate still CAPS
rather than denies**, now for single-member runs too: accounts that crossed the line before
the boundary check existed are still out there, and denying them left the whole family unable
to generate anything. A run targeting a capped-out member is refused; everything else degrades.

**Upgrade CTAs must resolve their destination.** An over-limit household by definition already
pays, and `/api/checkout` 409s an existing subscriber — so `/pricing` was a dead end for
exactly the people who saw the paywall. Both the wizard and the /plan blocked-members banner
now route to `/subscription` when `hasLiveLemonsqueezySubscription(sub)`, and drop the
«اشتركي» wording for someone who is already subscribed.

**Webhook: variant over custom_data, and ordering is not free.** `custom_data` is frozen at
the original checkout, but `/api/subscription/change` swaps the variant on the EXISTING
subscription and cannot rewrite it — so renewal invoices were stamping the OLD tier back and
silently downgrading a customer one billing cycle after they upgraded. Tier/cadence now come
from `variant_id` via `getTierCadenceByVariantId`, with `custom_data` only as fallback.
`deriveCadence` is DELETED (it resolved variants by different rules and would have returned
null once live ids were set). Delivery is at-least-once and unordered, so `last_event_at`
(00024) records `attributes.updated_at` of the last applied event and older ones are ignored.
`payment_success` may claim the row ONLY when it holds no subscription id — unlike
`subscription_created` it also fires for renewals.

**Reconciliation joins on IDENTITY, not email.** Checkout deliberately does not prefill the
email, so the address on the LemonSqueezy side is whatever the customer typed — matching on it
missed exactly the people the self-heal exists for, and let an account whose email matched
someone else's checkout inherit that subscription (including the id `/cancel`, `/pause` and
`/change` act on). Now: stored `lemonsqueezy_customer_id` first; the cold-start email path
requires the subscription's own `custom_data.user_id` to name this user.

**Family surfaces must ROSTER-FILTER.** `member_id` is TEXT with no FK (it carries the `"mom"`
and `"household"` sentinels), so removing a member orphans their rows. The per-member scoring
filtered the roster and the family counters did not, so the ring/strip counted meals for
someone no longer in the household while nobody's score moved — the family total could not
reconcile with the sum of its members. Both filter now (keeping `'household'`, which names no
member by design), and `removeFamilyMember` purges the member's `meal_checkins`,
`meal_verdicts`, `workout_checkins`, `meal_absences`, `body_logs` and their entry in
`member_addition_order`.

**Postgres `numeric` may arrive as a STRING.** Coerce with `Number()`, never type-guard with
`typeof v === "number"` — the weekly recap's weight line was permanently null because of it,
and its unit test passed numbers straight into the pure function so it could never catch it.
`seasonProps.ts` and `memberEdit.ts` already did this correctly.

**Redirect targets from the URL are attacker-supplied.** `safeRedirectPath`
(`apps/app/src/lib/safeRedirect.ts`) is the ONE definition — same-origin absolute paths only.
`redirect_to` went unvalidated into `window.location.assign()`, making the login page an open
redirect *after* a successful sign-in. Used by LoginForm and `/auth/callback`.

**`onboarding_completed_at` is a GATE, not a flag.** `syncFamilyPlanAfterSubscribe` and
`drainDeferredMembers` both return immediately when it is null. Its write errors are now read
and the redirect refused on failure — discarding them meant a customer could pay and never
get a plan generated, with nothing surfaced anywhere.

**Ops.** Set `INTERNAL_FUNCTION_SECRET` in Netlify — the app→background-function bearer secret
was the Supabase SERVICE-ROLE KEY, sent as a header to a URL built from a `NEXT_PUBLIC_` var.
It falls back to the service-role key while unset, so setting it is what stops the fallback.
`NEXT_PUBLIC_FREE_ACCESS_MODE` makes `getTierLimit` return null for everyone, so the whole
tier-limit cluster above is bypassed and untestable while it is on.

**Housekeeper identity (closed 08/2026 by migration 00025).** Keyed off `role` in ~40
places and `member_type` in 5 — `familyMemberInputSchema` now rejects `role: "housekeeper"`
(that was a tier-limit bypass), but the dual key itself stands; **00025 adds exactly that CHECK**, and repairs both directions first so it cannot reject
on apply (the single write path in `addHousekeeper` already sets both, so the repairs are
no-ops on a healthy table). APPLIED to prod (owner confirmed 08/2026);
`scripts/verify-migrations.sql` covers it. Plus three
low-severity leads not independently verified: feminine-only copy for a male owner through the
member wizards, the claim that member edits auto-regenerate via `memberEdit.ts` being
UI-reachable, and housekeeper-language sold as `family`-tier-only while reachable on every tier.

---

## 7/7 as arithmetic: the generation-economics rebuild, Stages 0+1 (08/2026)

The owner's directive: «economical price for each generation, 0 failed attempts, all the
generations should return all 7 days in a reasonable time». Measured before the change,
a 5-beneficiary + housekeeper household delivered 1-4 days of 7 per invocation at
$2.02-3.32 (0 of ~12 attempts ever completed a week in one run), a clean week cost ~$3.40
of tokens but ~$7-8 in practice, and a partial week then waited for a PAGE VISIT because
`DeferredMemberDrain` is the only self-heal and it mounts on /plan + /dashboard only.
A four-phase multi-agent audit (token anatomy on real prod plans, budget arithmetic,
continuation feasibility, a failure ledger over all 26 recorded runs) found the causes;
adversarially-verified fixes shipped as Stages 0+1. Stage 2 (dish-once emission, a further
~30% output cut) is designed but deliberately NOT shipped until compact emission is proven
on production runs.

**The three measurement facts that reframed everything.** (1) Two obvious fixes had
ALREADY shipped (07-24, commit fd63a3a): translation left the day call (it is the separate
Haiku pass) and shared-batch math moved into code — but `dayMaxTokens`/`bigCallTimeoutMs`
still carried `hasTranslation ? 4500 : 2600` tok and `70s : 40s` per-member branches
pricing the INLINE era. The fossil only bought bigger caps and longer doomed calls (450s
ceilings for ~200-250s of work). Both branches are DELETED; the helpers take memberCount
alone. (2) The model flips a coin on formatting: measured tok/byte across prod runs is
bimodal — 0.54 (compact JSON) vs 0.97 (pretty-printed), i.e. pretty costs +80% output —
and nothing pinned it. (3) 65-90% of recorded output spend was DISCARDED completions
(band/content re-rolls and truncation retries re-billing whole days), and aborted streams
record 0 tokens while Anthropic bills what streamed, so the cost gauge omitted exactly the
waste.

**Stage 0 — the call fits its budget.** `dayMaxTokens` = 3000 + **3400**/member (NOT the
2600 the fossil-removal alone would give: the cap must sit ABOVE the measured pretty-mode
emission ~17.5k @ 5 members until compact is proven, or every non-compact reply truncates
into the doubled-cap retry — verifier catch). `bigCallTimeoutMs` = 240s + 40s/member
(360s @ 5, was 450s). Compact JSON is pinned by a directive in the day + skeleton
prompts (dynamic blocks only — cached STATIC_SYSTEM untouched, no invalidation). An
**assistant prefill** was ALSO built for this and REMOVED the same day: the very first
production run answered `Anthropic API 400: This model does not support assistant message
prefill` — claude-sonnet-4-6 requires the conversation to end with a USER message, so the
directive + the generous caps carry compact-emission alone (which is exactly why the caps
were sized above pretty mode). The failure was itself a validation of Stage 1: a
deterministic 400 failed in 26s at $0 with the cause legible in `error_message`, instead
of burning retries. `anthropicStream.test.ts` pins the stream-death error contract with a
faked SSE body (every other test mocks `streamAnthropic` wholesale, so a regression there
would break salvage silently) and that requests end with a user turn. The small-household cliff is fixed:
`dayConcurrency` for 1/2/3 members is now 2/3/4 (sequential-1 could not fit a week from
3 members up, or 2 with a maid — the calm 1→7 fill was arithmetically unaffordable);
`PLAN_DAY_CONCURRENCY` now overrides small households too.

**Stage 1 — failure stops being a terminal state.** Five layers, each closing a ledger
entry: (a) ALL mid-stream deaths are `AnthropicCallError` — the raw-socket wrap (undici
`terminated`, was unretryable+unsalvageable, $2.02 lost once) and the SSE `error` event
(threw WITHOUT partialText, discarding the streamed text) both carry `partialText` + a
billed-spend estimate (`estimatedOutputTokens` ≈ streamed utf8 bytes × 0.6,
`inputTokensAtFailure` real from message_start); the message contains "stream error" ON
PURPOSE — `isRetryable` keys on it. Day-loop and skeleton catches accrue those estimates
into usage so failed calls stop reading $0. (b) The SKELETON gets the day loop's retry
discipline (it had ZERO retries — one 429 on the single most load-bearing call failed the
whole run): MAX_RETRIES API-transients honoring Retry-After + one content re-roll, gated
on `wait + MIN_VIABLE_CALL_MS + DAY_CALL_ESTIMATE_MS` — deliberately NOT
`dayLoopReserveMs`, which exceeds the whole budget at small-household concurrency
(verifier catch: the reserve-based gate would be dead code exactly where the skeleton
matters most). (c) The doubled-cap truncation retry is budget-gated (it was the ONE
ungated retry path). (d) `gen_attempts` now charges WIDE runs: every targeted member with
≥1 actually-ATTEMPTED (non-BUDGET_DEFERRED) missing day is bumped at snapshot time —
before this, the wide drain run could re-fire on every page visit forever
(MEMBER_GEN_MAX_ATTEMPTS could never trip while ≥2 members were short), unbounded spend
behind free-access mode. A hard-killed run may persist a count ±1 of final truth —
bounded noise, documented in code. (e) **The worker chains its own continuation**
(`generate-plan-background.mts` + `packages/plan-engine/src/chain.ts`): on the SUCCESS
path only, after BOTH terminal writes (the 'ready' plan is the child's carry-over source;
closing the audit row releases the 00014 per-kind lock BEFORE the child claims it), a run
that is short but made progress mints child meal_plans + plan_generations rows via
`sbInsertReturning` (23505 → a drain/manual dispatch won the seconds-wide unlock window:
archive the child, yield — the exact `createPlanRows` race protocol) and POSTs
**`req.url`** (never an env-derived URL — Functions-runtime env-scope mismatch is a
documented silent failure) with the in-process secret, `{userId, mealPlanId: childId,
carryOver: true, chainDepth+1, feedback, limitMemberIds}`, 8s abort, requires exactly
202. ANY enqueue failure (abort included) rolls back — archive child + fail child gen
row; safe even if the POST actually landed, because the late child no-ops at
`generationAlreadySettled`. Do NOT copy dispatch.ts's "timeout = probably enqueued"
here: that optimism leaks an orphan lock with no user watching. `shouldChainContinuation`
(one predicate, tested truth-table): missing days AND `daysCompleted > 0` (no progress →
no chain — an identical successor meets the same wall; this makes the hop cap bound
WASTE, not just invocations) AND `chainDepth < PLAN_CHAIN_MAX_HOPS` (3) AND **every
beneficiary present in the plan** (an absent member needs a skeleton + possibly
`regenerateSharedGroup`; the wide continuation has no such routing — the drain owns it)
AND someone short is under the attempt cap. The worker additionally chains only wide runs
(no onlyMemberId/regenerateMemberId/regenerateSharedGroup/regenScope). Chained hops NOTE
themselves on the parent's audit row («chained continuation (hop N)»).
`incompleteInPlanMemberIds` MOVED into the engine (chain.ts); `drainScope.ts` re-exports
it — drain and chain deciding "who is short" from one definition, per the same-rule-twice
root cause. Its old comment claimed carry-over runs are "skeleton-free"; that is FALSE
for family-wide day losses (familyDishGrid seeds only from days WITH meals), corrected in
place — a hop refilling whole-family days re-runs a skeleton and still fits its fresh
budget.

**What this does NOT close (known, accepted):** a platform hard-kill before the terminal
writes cannot chain (recovery = the 90s ACK sweep + 15-min staleness + page visit, as
today, on a now-smaller exposure window); a deterministically model-hostile member caps
at 3 attempts and ships a visible short week instead of burning unbounded money; a fresh
run where ALL days fail throws and never chains (the retry card, as today). Concurrency 7
for LARGE households (one wave) is deliberately NOT the default until a QA probe rules
out Sonnet 429s — `PLAN_DAY_CONCURRENCY=7` is the env lever. Stage 2 (dish-once emission,
day calls ~7k tokens, ~$1.2-1.5/week for 6 people) waits on 2-3 production runs proving
compact emission ≈100%; only then tighten `dayMaxTokens` toward 2600/member. Guarded by
`chain.test.ts`, `anthropicStream.test.ts`, the reworked `dayBudget.test.ts` (asserts the
old sequential cliff could NOT fit and the new 2/3/4 fill can) + `skeletonBudget.test.ts`;
the bg function remains a mirror — **when changing `runMealPlanGeneration` or the engine's
retry/budget behavior, check generate-plan-background.mts: it is the production path.**

**Stage 1 of the delivery plan (08/30/2026): the $4.16-for-zero-days class is closed.**
The first calibration run after the Stage 0+1 rebuild failed by CAP ARITHMETIC, not
model behavior: the day cap (20k) sat INSIDE the measured emission band (19-26k), so
every day call truncated at the cap, billed in full, then burned a doomed doubled-cap
retry under a ceiling too short for it — and the error summary's plurality vote over
EXACT strings let 2 free deferrals outvote 5 paid deaths ("no model call made" on a run
that made ~11). Five fixes, one deploy: (1) `dayMaxTokens` = 3000+**5800**/member (32k
at 5 members — above every measured mode; a cap bills only real tokens) and
`bigCallTimeoutMs` DERIVED from the cap (cap/65 tok/s + 20s TTFT ≈ 512s @5) so the pair
cannot drift apart again — pinned by a dayBudget.test invariant. (2) The salvage gate
accepts TRUNCATION throws (`PlanValidationError.rawResponse` on /hit max_tokens/), not
only dead streams — a twice-truncated day is rescued member-by-member instead of
discarding 20-32k billed tokens. (3) **Phase-1 hard deadline**: run deadline minus
`dayLoopReserveMs(days, conc, dayCallEstimateMs(bigCallTimeoutMs(m)))` — the reserve
now uses THE SAME per-day figure as the day loop's start gate (their drift was the
all-defer inversion); no 45s floor; an attempt (first or retry) is REFUSED below 0.6×
the skeleton ceiling (`Phase 1 refused` before any model call, $0). At 5-6 members +
maid this leaves ~180s of skeleton window — single-attempt-then-retry-card, accepted
until Stage 2 shrinks emissions. (4) `summarizeDayErrors` is a normalized CLASS
HISTOGRAM ("5x max_tokens(32000); 2x deferred (no model call)") + a model-call census
`[N model calls]` on missingDaysCause and the all-days-failed throw
(`normalizeDayErrorClass` strips day indices/ms figures/salvage annotations). (5) Cost
honesty: `StreamResult` carries `cacheCreationTokens`/`cacheReadTokens` (message_start),
`computeCostUsd` prices them (1.25×/0.1× input rate — recorded costs rise ~10-30%, that
traffic was always billed and never recorded); dead streams prefer a real usage figure
over the 0.6 tok/byte estimate; `PRICING_USD_PER_MTOK_BY_MODEL` fixed (opus-4-7 was CUT
to $5/$25 — verified against current docs 08/2026; sonnet-5 $2/$10 and opus-5 added)
and the bg function warns when an env-pointed model id has no pricing entry
(`isKnownPricingModel`) since the conservative fallback over-reports up to ~7.5×. Plus:
a skeleton that silently DROPS members (schema min(1) tolerates it; produced the 08/30
zero-macro shells) now warns to Sentry. Guarded by the reworked deadline.test.ts (the
"skeleton alone consumed the budget" scenario is now IMPOSSIBLE and its test asserts
the refusal instead), dayFailure.test Part G (truncation salvage), and the dayBudget
reserve≥gate + cap≤ceiling invariants. NOTE: deadline.test fixtures assume the solo
phase-1 floor (~690s = 4 waves × 150s + 0.6×150s) — a synthetic deadline below it now
refuses phase 1 up front, by design.

**Offline stages 2/3/4 built while API credits were exhausted (08/31/2026) — INERT until the env levers flip.**
Everything below deploys dark; the calibration session activates it. (1) **Structured
outputs (Stage 2)**: `streamAnthropic` gained `outputFormat` → `output_config.format`
(raw wire `{type:"json_schema", schema}`); `terseDaySliceSchema.ts` mirrors
`expandTerseDaySlice`'s input exactly (additionalProperties:false everywhere, NO
numeric/length keywords — zod keeps those app-side; drift pinned by its test). **CRITICAL
DISCOVERY: claude-sonnet-4-6 does NOT support structured outputs** (same family trait as
the prefill rejection) — supported: fable-5, opus-5/4.8, **sonnet-5**, **haiku-4-5**. So
the day call sends a schema only when `supportsStructuredOutputs(DAY_MODEL)`, and THE
ACTIVATION LEVER IS `PLAN_DAY_MODEL=claude-sonnet-5` in the Netlify UI — which is ALSO
cheaper than 4.6 ($2/$10 vs $3/$15). Rollback = delete the var. (2) **gen_metrics
telemetry**: the final plan carries `plan_data.gen_metrics` (day tok/byte list — the
emission-mode fingerprint ~0.55 compact / ~0.97 pretty / >1.2 escaped-or-degenerate —
truncations, schema failures, band first-pass rate, salvages, model, call census; schema
passthrough, no migration) + a once-per-run Sentry tripwire at tok/B>1.2. This is what
answers the STILL-OPEN question of why day emissions escalated 19k→26k→>32k across the
08/30-31 runs (aggregates could not; the failed-day attempt-trace + reply-shape
annotations from 75d4ab1 feed the same answer on failures). (3) **Dish-once (Stage 3)**
behind `PLAN_DISH_ONCE=1` (default OFF): multi-member day calls emit each dish ONCE
(`ds` array with per-sharer `ps` portion lines, amounts aligned to `ig`); prompt block +
sharedRule variant move with the SAME flag (`systemPrompt.ts`), matching enforced schema
(`dishOnceDaySlice.ts`), and `expandDishOnceDaySlice` fans back to the canonical
per-member shape BEFORE zod so band/rescale/splice/resync/absence/PDF/translation see
bytes they always saw. Routing is by REPLY shape (`ds` key), so disobedient models and
old plans parse; `rescueDaySlice` routes the same way (the review's flagged breaker);
misaligned portion arrays throw a re-rollable PlanValidationError (never fabricate
quantities). Golden equivalence + truncation-fuzz + prompt-flag tests in
`dishOnce.test.ts`. (4) **Scheduled sweeper (Stage 4)**:
`netlify/functions/sweep-generations.mts` (cron `*/5 * * * *`) — reclassifies stale
'started' meal rows + 'generating' plans past `STALE_GENERATION_MIN`, then dispatches
wide refills exactly like the chain (mint rows → 23505 = someone else is healing →
archive+yield; POST worker via `req.url`-derived URL, exactly-202, rollback). Decision
half is PURE in `src/lib/plans/sweep.ts` (`decideSweep`, truth-table tested): onboarding
done, no live meal run, `SWEEP_DAILY_GEN_CAP=8` recent gen rows/24h (a cron dispatching
PAID runs must be unable to loop — free-access mode removes every other bound), ready
plan WITH content in a 5-row window (`previousPlanFallback` semantics — after the credit
incident the newest rows were all failed), short members under `MEMBER_GEN_MAX_ATTEMPTS`,
NO absent beneficiary (drain keeps that routing). Max 3 dispatches per firing.
Translation refills deliberately stay with the housekeeper page + end-of-run pass.
QA harness: `scripts/qa-e2e/dispatch-household.mjs` (browserless dispatch — builds the
@supabase/ssr cookie by hand; Playwright can't cross this environment's proxy) +
`watch-generations.mjs`. **Credit-available runbook**: top up credits → set
`PLAN_DAY_MODEL=claude-sonnet-5` → dispatch+watch one 5-member run → read gen_metrics
(compact holding? band pass?) → if clean, set `PLAN_DISH_ONCE=1` → one more run → read
$/person. The 08/31 credit-exhaustion run also proved the failure UX: 400s fail fast at
$0 with the exact cause + request id in error_message.
