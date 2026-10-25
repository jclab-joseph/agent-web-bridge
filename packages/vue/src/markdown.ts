import MarkdownIt from 'markdown-it'

// Raw HTML stays escaped (html: false) and markdown-it rejects javascript: and similar link targets,
// so rendered agent output is safe for v-html.
const md = new MarkdownIt({ html: false, linkify: true })

const renderLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet('target', '_blank')
  tokens[idx]!.attrSet('rel', 'noopener noreferrer')
  return renderLink(tokens, idx, options, env, self)
}

export function renderMarkdown(source: string): string {
  return md.render(source)
}
