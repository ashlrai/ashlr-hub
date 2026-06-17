/**
 * M44 — fixed eval fixtures.
 *
 * A small, deterministic set of SHORT, self-contained coding/reasoning goals a
 * 7B-class local model can attempt without any engineer tools. Used by the
 * `ashlr eval` harness to compare the agent loop with adaptive prompts OFF vs
 * ON and prove the M41–M43 uplift.
 *
 * Keep these tool-free-friendly (no file I/O, no repo context) so a run can
 * complete on a bare local provider with `{ tools: false }`.
 */

export interface EvalFixture {
  /** Stable, unique id used as the table row key. */
  id: string;
  /** The self-contained goal handed to runGoal(). */
  goal: string;
}

export const EVAL_FIXTURES: EvalFixture[] = [
  {
    id: 'palindrome',
    goal: 'Write a TypeScript function `isPalindrome(s: string): boolean` and show its code.',
  },
  {
    id: 'debounce-explain',
    goal: 'Explain in exactly 3 bullet points what a debounce function does.',
  },
  {
    id: 'fizzbuzz',
    goal: 'Write a JavaScript function that prints FizzBuzz for numbers 1 to 15. Show the code.',
  },
  {
    id: 'reverse-words',
    goal: 'Write a Python function `reverse_words(s: str) -> str` that reverses the order of words in a sentence. Show the code.',
  },
  {
    id: 'http-vs-https',
    goal: 'In 2 sentences, explain the difference between HTTP and HTTPS.',
  },
  {
    id: 'sum-array',
    goal: 'Write a one-line TypeScript expression that sums an array of numbers named `xs`.',
  },
];
