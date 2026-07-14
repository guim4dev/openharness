/** One curated prompt in a PromptLibrary: frontmatter metadata plus its body. */
export interface PromptEntry {
  name: string;
  description: string;
  /** The markdown body after the frontmatter block, trimmed. */
  text: string;
}

/** A loaded PromptLibrary: curated prompt name -> its entry. */
export type PromptLibrary = Map<string, PromptEntry>;
