import { matchIndex } from "@/lib/search";

/**
 * Marks where a search query occurs inside a label. `needle` must already be
 * normalized (see `lib/search`); an empty one renders the text untouched.
 */
export function Highlight({ text, needle }: { text: string; needle: string }) {
  const index = matchIndex(text, needle);
  if (index === -1) return <>{text}</>;

  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-[2px] bg-accent/30 text-foreground">{text.slice(index, index + needle.length)}</mark>
      {text.slice(index + needle.length)}
    </>
  );
}
