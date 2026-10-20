use super::*;

/// A compact rendering of a document: `type[attrs](children)`
fn render(node: &MarkdownNode) -> String {
    // The names of the snapshots, `LIST_ITEM` is `listItem`
    let mut out = String::new();
    for (i, part) in node.node_type.variant_name().unwrap_or("?").split('_').enumerate() {
        let part = part.to_ascii_lowercase();
        if i == 0 {
            out += &part;
        } else {
            out += &part[..1].to_ascii_uppercase();
            out += &part[1..];
        }
    }
    let mut attrs = Vec::new();
    for (key, value) in [("value", &node.value), ("url", &node.url), ("title", &node.title), ("lang", &node.language)] {
        if !value.is_empty() {
            attrs.push(format!("{key}={value:?}"));
        }
    }
    if node.node_type == MarkdownNodeType::HEADING {
        attrs.push(format!("level={}", node.level));
    }
    if node.node_type == MarkdownNodeType::LIST {
        attrs.push(format!("ordered={} tight={} start={}", node.ordered, node.tight, node.start));
    }
    if !attrs.is_empty() {
        out += &format!("[{}]", attrs.join(" "));
    }
    if !node.children.is_empty() {
        out += &format!("({})", node.children.iter().map(render).collect::<Vec<_>>().join(", "));
    }
    out
}

fn compile(template: &str) -> String {
    let document = compile_markdown_template(template).unwrap();
    render(&document.document)
}

#[test]
fn tokenizes_fields() {
    let document = compile_markdown_template("{{ a }} {{b}} {{a}} {{}} {{ ").unwrap();
    assert_eq!(document.fields, vec!["a", "b"]);
    assert_eq!(
        render(&document.document),
        "document(paragraph(field[value=\"a\"], text[value=\" \"], field[value=\"b\"], text[value=\" \"], \
         field[value=\"a\"], text[value=\" {{}} {{\"]))"
    );
    // The token prefix grows until it does not occur in the template
    let (markdown, _) = tokenize_fields(b"DASHQLMARKDOWNFIELD {{x}}");
    assert_eq!(markdown, b"DASHQLMARKDOWNFIELD DASHQLMARKDOWNFIELDX0TOKEN");
}

#[test]
fn splits_text_at_marks() {
    assert_eq!(
        compile("a\\*b &amp; c"),
        "document(paragraph(text[value=\"a\"], text[value=\"*\"], text[value=\"b \"], text[value=\"&\"], text[value=\" c\"]))"
    );
    assert_eq!(
        compile("&bogus; &#x41;"),
        "document(paragraph(text[value=\"&bogus;\"], text[value=\" \"], text[value=\"A\"]))"
    );
    assert_eq!(compile("a\0b"), "document(paragraph(text[value=\"a\"], text[value=\"\u{fffd}\"], text[value=\"b\"]))");
}

#[test]
fn builds_blocks() {
    assert_eq!(
        compile("# H1 #\n\nSetext\n---"),
        "document(heading[level=1](text[value=\"H1\"]), heading[level=2](text[value=\"Setext\"]))"
    );
    assert_eq!(
        compile("- a\n- b\n\n1) c"),
        "document(list[ordered=false tight=true start=0](listItem(text[value=\"a\"]), listItem(text[value=\"b\"])), \
         list[ordered=true tight=true start=1](listItem(text[value=\"c\"])))"
    );
    assert_eq!(
        compile("- a\n\n- b"),
        "document(list[ordered=false tight=false start=0](listItem(paragraph(text[value=\"a\"])), listItem(paragraph(text[value=\"b\"]))))"
    );
    assert_eq!(
        compile("```sql x\nselect\n```\n\n    code"),
        "document(codeBlock[lang=\"sql\"](text[value=\"select\"], text[value=\"\\n\"]), codeBlock(text[value=\"code\"], text[value=\"\\n\"]))"
    );
    assert_eq!(compile("<div>\nhtml\n</div>\n\n***"), "document(thematicBreak)");
    assert_eq!(compile("> q\n"), "document(blockquote(paragraph(text[value=\"q\"])))");
}

#[test]
fn resolves_links() {
    assert_eq!(
        compile("[a][ref] ![img](/x.png \"t\") <https://x.y> <me@x.y> [bad](javascript:x)\n\n[REF]: http://r 'T'"),
        "document(paragraph(link[url=\"http://r\" title=\"T\"](text[value=\"a\"]), text[value=\" \"], \
         image[url=\"/x.png\" title=\"t\"](text[value=\"img\"]), text[value=\" \"], link[url=\"https://x.y\"](text[value=\"https://x.y\"]), \
         text[value=\" \"], link[url=\"mailto:me@x.y\"](text[value=\"me@x.y\"]), text[value=\" \"], span[url=\"javascript:x\"](text[value=\"bad\"])))"
    );
    assert_eq!(
        compile("[x]({{f}} \"{{f}}\")"),
        "document(paragraph(span[url=\"DASHQLMARKDOWNFIELD0TOKEN\"](text[value=\"x\"])))"
    );
}

#[test]
fn resolves_emphasis() {
    assert_eq!(compile("***a** b*"), "document(paragraph(emphasis(strong(text[value=\"a\"]), text[value=\" b\"])))");
    assert_eq!(compile("a_b_c *x*"), "document(paragraph(text[value=\"a_b_c \"], emphasis(text[value=\"x\"])))");
    assert_eq!(compile("`` a`b ``"), "document(paragraph(inlineCode(text[value=\"a`b\"])))");
    assert_eq!(
        compile("a  \nb\\\nc"),
        "document(paragraph(text[value=\"a\"], hardBreak, text[value=\"b\"], hardBreak, text[value=\"c\"]))"
    );
}

#[test]
fn checks_urls() {
    assert!(is_safe_url(b"https://x"));
    assert!(is_safe_url(b"/a:b"));
    assert!(is_safe_url(b"a?b:c"));
    assert!(is_safe_url(b" MailTo:x"));
    assert!(!is_safe_url(b"java\nscript:alert(1)"));
    assert!(!is_safe_url(b"data:text"));
}

#[test]
fn packs_documents() {
    let document = compile_markdown_template("# {{a}}").unwrap();
    let mut builder = FlatBufferBuilder::new();
    let spec = pack_markdown_spec(&mut builder, &document);
    builder.finish(spec, None);
    let spec = flatbuffers::root::<MarkdownSpec>(builder.finished_data()).unwrap();
    assert_eq!(spec.template(), Some("# {{a}}"));
    let root = spec.document().unwrap();
    assert_eq!(root.node_type(), MarkdownNodeType::DOCUMENT);
    assert_eq!(root.value(), None);
    let heading = root.children().unwrap().get(0);
    assert_eq!(heading.level(), 1);
    assert_eq!(heading.children().unwrap().get(0).value(), Some("a"));
}

#[test]
fn reproduces_md4c_quirks() {
    // The empty list item check reads the last line of the paragraph (it starts at offset 4) as a block header
    // with the type MD_BLOCK_LI, so the blank lines end the list
    assert_eq!(
        compile("-   a\n\n\n  b"),
        "document(list[ordered=false tight=true start=0](listItem(text[value=\"a\"])), paragraph(text[value=\"b\"]))"
    );
    // At offset 2, the same list stays one loose list
    assert_eq!(
        compile("- a\n\n\n  b"),
        "document(list[ordered=false tight=false start=0](listItem(paragraph(text[value=\"a\"]), paragraph(text[value=\"b\"]))))"
    );
    // A NUL byte in a code block is also the first byte of the following text
    assert_eq!(
        compile("    a\0b"),
        "document(codeBlock(text[value=\"a\"], text[value=\"\u{fffd}\"], text[value=\"\\0b\"], text[value=\"\\n\"]))"
    );
}
