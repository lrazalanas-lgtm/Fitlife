import Image from "next/image";

/**
 * The closing section's portrait — the result the copy promises, shown rather
 * than illustrated.
 *
 * It is FRAMED rather than dropped in loose, in the same paper-and-edge
 * language the ValueStack gifts panel uses: a rounded card, a hairline, and the
 * page's gold top edge.
 *
 * The framing does more work now than it did for the previous portrait. That
 * photograph sat on a warm plum backdrop a step off this section's night field,
 * so it needed the card to stop reading as a mismatched patch of background,
 * plus a gradient at its foot to dissolve the bottom edge into the page. This
 * one is shot on a light studio grey (#EBEBEB) — it is a BRIGHT object on a
 * dark field, already fully separated from it, so the card's job is to give
 * that brightness a deliberate boundary rather than to hide a seam. The bottom
 * fade is gone with the problem it solved: over a light backdrop it would read
 * as a dark smudge across her, not as a transition, and the photo's own frame
 * is the cleaner close.
 *
 * The `src` is a plain path, NOT a static import. A static import needs the
 * `*.webp` module declaration that `next-env.d.ts` pulls in, and that file is
 * generated and gitignored — so `tsc --noEmit` passes locally (where a previous
 * build left one behind) and fails in CI, which type-checks before it builds.
 * The card carries the photo's own backdrop colour so the image resolves onto a
 * matching tone instead of flashing.
 *
 * width/height are the file's real pixels, so the reserved box matches the
 * source exactly and nothing is cropped or letterboxed. The section sits well
 * below the fold, so this stays lazy (next/image's default) and never competes
 * with the hero for the LCP.
 */
export function FinalCTAPortrait() {
  return (
    <div className="edge-gold relative mx-auto w-full max-w-[19rem] overflow-hidden rounded-3xl bg-[#ebebeb] ring-1 ring-white/12 lg:max-w-md">
      <Image
        src="/final-cta-woman.webp"
        alt="امرأة ترتدي زيّ فت لايف الرياضي البنفسجي، تنظر بعيداً بثقة وابتسامة هادئة"
        width={1123}
        height={1400}
        sizes="(min-width: 1024px) 28rem, 19rem"
        className="h-auto w-full"
      />
    </div>
  );
}
