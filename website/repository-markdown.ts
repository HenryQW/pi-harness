const repository = new URL("https://github.com/HenryQW/pi-harness/blob/main/");

export const linkRelativeMarkdownToGitHub = (markdown: string, editPath: string) => {
  const readme = new URL(editPath, repository);
  return markdown.replace(
    /\]\((\.\.?\/[^)\s]+\.md(?:#[^)\s]+)?)\)/g,
    (_, target: string) => `](${new URL(target, readme)})`
  );
};
