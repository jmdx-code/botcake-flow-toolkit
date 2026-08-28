export function buildCreateBotcakeTagForm(name: string): FormData {
  const form = new FormData();
  form.append("selectedTag[name]", name);
  return form;
}
