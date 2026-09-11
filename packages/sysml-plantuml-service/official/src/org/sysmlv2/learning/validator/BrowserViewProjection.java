package org.sysmlv2.learning.validator;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.omg.sysml.lang.sysml.*;
import org.eclipse.xtext.nodemodel.util.NodeModelUtils;

/** BrowserView 展示声明的成员层级，不沿 typing、import、connection 或 expose 再次展开目标。 */
final class BrowserViewProjection {
    static Map<String, Object> project(ViewUsage view) {
        List<Element> exposed = view.getExposedElement().stream()
            .filter(BrowserViewProjection::visible).distinct().toList();
        IdentityHashMap<Element, Boolean> exposedSet = new IdentityHashMap<>();
        exposed.forEach(e -> exposedSet.put(e, true));
        List<Element> roots = exposed.stream().filter(e -> {
            for (Element owner = e.getOwner(); owner != null; owner = owner.getOwner()) {
                if (exposedSet.containsKey(owner)) return false;
            }
            return true;
        }).toList();
        List<Map<String, Object>> nodes = new ArrayList<>();
        IdentityHashMap<Element, Boolean> visited = new IdentityHashMap<>();
        for (Element root : roots) add(root, "", 0, nodes, visited);
        if (nodes.isEmpty()) throw new IllegalArgumentException("BROWSER_EMPTY_EXPOSE");
        return Map.of("profile", "browser-membership", "nodes", nodes,
            "viewName", text(view.getQualifiedName()));
    }

    private static boolean visible(Element element) {
        return !element.isImpliedIncluded() && !(element instanceof Documentation)
            && !(element instanceof Comment) && (!(element instanceof Relationship) || element instanceof Namespace)
            && NodeModelUtils.getNode(element) != null;
    }

    private static void add(Element element, String parentId, int depth,
            List<Map<String, Object>> nodes, IdentityHashMap<Element, Boolean> visited) {
        if (!visible(element) || visited.containsKey(element)) return;
        if (depth > 32 || nodes.size() >= 1000) throw new IllegalArgumentException("BROWSER_MEMBERSHIP_LIMIT");
        visited.put(element, true);
        String id = "b" + nodes.size();
        String name = text(element.getDeclaredName());
        if (name.isBlank()) name = text(element.getDeclaredShortName());
        String kind = element.eClass().getName();
        String typeName = element instanceof Feature feature ? feature.getType().stream()
            .filter(t -> t.eResource() == element.eResource()).map(t -> text(t.getName()))
            .filter(n -> !n.isBlank()).reduce((a, b) -> a + ", " + b).orElse("") : "";
        String declaration = "";
        // 匿名 connect / satisfy / succession 仍是可见成员；显示原声明，保留端点与关系含义。
        if (name.isBlank()) {
            var syntax = NodeModelUtils.getNode(element);
            if (syntax != null) declaration = NodeModelUtils.getTokenText(syntax).replaceAll("\\s+", " ").trim();
            int brace = declaration.indexOf('{');
            if (brace >= 0) declaration = declaration.substring(0, brace).trim();
        }
        Map<String, Object> node = new LinkedHashMap<>();
        node.put("id", id);
        node.put("parentId", parentId);
        node.put("depth", depth);
        node.put("name", name.isBlank() ? (declaration.isBlank() ? kind : declaration) : name);
        node.put("kind", kind);
        node.put("typeName", typeName);
        node.put("sourceElementId", text(element.getElementId()));
        node.put("qualifiedName", text(element.getQualifiedName()));
        nodes.add(node);
        if (element instanceof Namespace namespace) {
            for (Element member : namespace.getOwnedMember()) {
                if (member.eResource() == element.eResource()) add(member, id, depth + 1, nodes, visited);
            }
        }
    }

    private static String text(String value) { return value == null ? "" : value; }
}
