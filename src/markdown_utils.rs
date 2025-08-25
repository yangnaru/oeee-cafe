use markdown::{to_mdast, mdast, to_html, ParseOptions};

/// Process markdown content by converting headings to paragraphs and rendering to HTML
pub fn process_markdown_content(value: &str) -> String {
    let ast = match to_mdast(value, &ParseOptions::default()) {
        Ok(ast) => ast,
        Err(_) => return value.to_string(), // Return original text on parse error
    };
    
    let processed_ast = convert_headings_to_paragraphs(ast);
    
    // Convert AST back to markdown string, then to HTML
    let processed_md = mdast_to_markdown(&processed_ast);
    to_html(&processed_md)
}

fn convert_headings_to_paragraphs(node: mdast::Node) -> mdast::Node {
    match node {
        mdast::Node::Heading(heading) => {
            mdast::Node::Paragraph(mdast::Paragraph {
                children: heading.children,
                position: heading.position,
            })
        }
        mdast::Node::Root(mut root) => {
            root.children = root.children
                .into_iter()
                .map(convert_headings_to_paragraphs)
                .collect();
            mdast::Node::Root(root)
        }
        mdast::Node::Blockquote(mut blockquote) => {
            blockquote.children = blockquote.children
                .into_iter()
                .map(convert_headings_to_paragraphs)
                .collect();
            mdast::Node::Blockquote(blockquote)
        }
        mdast::Node::List(mut list) => {
            list.children = list.children
                .into_iter()
                .map(convert_headings_to_paragraphs)
                .collect();
            mdast::Node::List(list)
        }
        mdast::Node::ListItem(mut list_item) => {
            list_item.children = list_item.children
                .into_iter()
                .map(convert_headings_to_paragraphs)
                .collect();
            mdast::Node::ListItem(list_item)
        }
        _ => node, // Leave other nodes unchanged
    }
}

fn mdast_to_markdown(node: &mdast::Node) -> String {
    // Simple converter - for a full implementation, we'd need the markdown-to-mdast crate
    match node {
        mdast::Node::Root(root) => {
            root.children.iter().map(mdast_to_markdown).collect::<Vec<_>>().join("\n\n")
        }
        mdast::Node::Paragraph(para) => {
            para.children.iter().map(mdast_to_markdown).collect::<Vec<_>>().join("")
        }
        mdast::Node::Text(text) => text.value.clone(),
        mdast::Node::Strong(strong) => {
            format!("**{}**", strong.children.iter().map(mdast_to_markdown).collect::<Vec<_>>().join(""))
        }
        mdast::Node::Emphasis(emphasis) => {
            format!("*{}*", emphasis.children.iter().map(mdast_to_markdown).collect::<Vec<_>>().join(""))
        }
        mdast::Node::Code(code) => {
            format!("`{}`", code.value)
        }
        mdast::Node::Link(link) => {
            format!("[{}]({})", 
                link.children.iter().map(mdast_to_markdown).collect::<Vec<_>>().join(""),
                link.url
            )
        }
        _ => String::new(), // Handle other node types as needed
    }
}