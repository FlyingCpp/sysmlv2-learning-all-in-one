package org.sysmlv2.learning.validator;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.omg.sysml.lang.sysml.*;

/** 从官方已解析对象投影身份与关系，不解析源码或反推 SVG 坐标。 */
final class DiagramProjection {
    private static final java.awt.Font FONT = new java.awt.Font("Noto Sans CJK SC", java.awt.Font.PLAIN, 14);
    private static final java.awt.font.FontRenderContext FONT_CONTEXT = new java.awt.font.FontRenderContext(null, true, true);
    private final List<Map<String, Object>> nodes = new ArrayList<>();
    private final List<Map<String, Object>> ports = new ArrayList<>();
    private final List<Map<String, Object>> edges = new ArrayList<>();
    private final List<Context> contexts = new ArrayList<>();
    private final boolean action;

    private DiagramProjection(boolean action) { this.action = action; }

    static Map<String, Object> project(ViewUsage view, String mode) {
        if (view == null || !(mode.equals("INTERCONNECTION") || mode.equals("ACTION") || mode.equals("DEFAULT"))) return null;
        if (mode.equals("DEFAULT") && view.getExposedElement().stream().anyMatch(e -> e instanceof RequirementDefinition || e instanceof RequirementUsage)) {
            return RequirementHierarchyProjection.project(view);
        }
        try {
            DiagramProjection p = new DiagramProjection(mode.equals("ACTION"));
            List<Element> exposed = view.getExposedElement();
            if (exposed.isEmpty()) throw new IllegalArgumentException("EMPTY_EXPOSE");
            // expose 返回元素集合而非画布根；连接和父子重复命中必须先归一化。
            IdentityHashMap<Element, Boolean> selected = new IdentityHashMap<>();
            for (Element element : exposed) selected.put(element, true);
            List<Element> roots = new ArrayList<>();
            for (Element element : exposed) {
                if (element instanceof Connector) {
                    if (mode.equals("DEFAULT")) throw new IllegalArgumentException("GENERAL_EXPOSED_CONNECTOR_REQUIRES_NATIVE_PROJECTION");
                    continue;
                }
                Element owner = element.getOwner();
                boolean nested = false;
                while (owner != null) {
                    if (selected.containsKey(owner) && (p.action ? owner instanceof ActionDefinition || owner instanceof ActionUsage
                            : owner instanceof PartDefinition || owner instanceof PartUsage) && !(owner instanceof Connector)) {
                        nested = true;
                        break;
                    }
                    owner = owner.getOwner();
                }
                if (nested || roots.contains(element)) continue;
                boolean supported = p.action
                    ? element instanceof ActionDefinition || element instanceof ActionUsage
                    : element instanceof PartDefinition || element instanceof PartUsage;
                if (!supported || element instanceof ConnectionUsage || element instanceof ViewUsage) {
                    throw new IllegalArgumentException("UNSUPPORTED_EXPOSED_ELEMENT");
                }
                roots.add(element);
            }
            for (Element element : roots) p.addNode((Type) element, null, new IdentityHashMap<>());
            Context canvas = new Context(null, "");
            for (Context context : p.contexts) if (roots.contains(context.type) && context.type instanceof Feature feature) {
                canvas.children.put(feature, context);
                canvas.members.put(feature, context.id);
            }
            for (Context context : p.contexts) {
                if (!mode.equals("DEFAULT")) p.addEdges(context);
            }
            if (!mode.equals("DEFAULT")) for (Element element : exposed) if (element instanceof Connector connector) {
                // 已在所属显示上下文处理的连接不得重复添加；包级连接在画布上下文解析。
                boolean included = p.contexts.stream().anyMatch(c -> c.type.getFeature().contains(element));
                if (!included) p.addEdge(canvas, (Feature) connector);
            }
            if (mode.equals("DEFAULT")) for (Map<String, Object> node : p.nodes) {
                if (!"".equals(node.get("parentId"))) p.edges.add(Map.of("id", "h" + p.edges.size(),
                    "source", node.get("parentId"), "target", node.get("id"),
                    "kind", Boolean.TRUE.equals(node.get("isReference")) ? "reference-part" : "part-membership"));
            }
            if (mode.equals("DEFAULT")) for (Context context : p.contexts) {
                for (Specialization specialization : context.type.getOwnedSpecialization()) {
                    String kind = specialization instanceof FeatureTyping ? "feature-typing"
                        : specialization instanceof Subclassification ? "subclassification" : null;
                    if (kind == null) continue;
                    for (Context target : p.contexts) if (target.type == specialization.getGeneral()) {
                        p.edges.add(Map.of("id", "h" + p.edges.size(), "source", context.id, "target", target.id, "kind", kind));
                    }
                }
            }
            return Map.of("status", "ready", "profile", mode.equals("DEFAULT") ? "part-hierarchy" : p.action ? "action-flow" : "port-network",
                "nodes", p.nodes, "ports", p.ports, "edges", p.edges, "viewName", text(view.getQualifiedName()),
                "fontFamily", FONT.getFamily(), "fontSize", 14,
                "presentation", Map.of("exposedElementCount", exposed.size(), "displayRootCount", roots.size()));
        } catch (IllegalArgumentException error) {
            return Map.of("status", "unsupported", "reason", error.getMessage());
        }
    }

    private Context addNode(Type type, Context parent, IdentityHashMap<Type, Boolean> ancestors) {
        if (type instanceof Feature f && org.omg.sysml.util.FeatureUtil.getValuationFor(f) != null) {
            throw new IllegalArgumentException("FEATURE_VALUE_REQUIRES_NATIVE_PROJECTION");
        }
        if (nodes.size() >= 200 || ancestors.size() >= 12 || ancestors.containsKey(type)) {
            throw new IllegalArgumentException("PROJECTION_LIMIT_OR_RECURSION");
        }
        IdentityHashMap<Type, Boolean> branch = new IdentityHashMap<>(ancestors);
        branch.put(type, true);
        String id = "n" + nodes.size();
        Map<String, Object> node = base(type, id);
        node.put("parentId", parent == null ? "" : parent.id);
        node.put("role", action ? "action" : "part");
        node.put("isDefinition", type instanceof Definition);
        node.put("isReference", type instanceof Usage usage && usage.isReference());
        node.put("documentation", type.getDocumentation().stream().map(d -> text(d.getBody())).toList());
        node.put("documentationLines", wrap(type.getDocumentation().stream().map(d -> text(d.getBody())).reduce("", (a, b) -> a + b + "\n"), 660));
        nodes.add(node);
        Context context = new Context(type, id);
        contexts.add(context);
        for (Feature feature : type.getFeature()) {
            // 标准库隐式成员不形成教学图元；用户继承成员仍来自同一工作区资源。
            if (feature.eResource() != type.eResource() || feature.isImpliedIncluded()) continue;
            if (feature instanceof Connector) continue;
            if (feature instanceof PortUsage && !action) {
                if (ports.size() >= 1200) throw new IllegalArgumentException("PORT_BUDGET_EXCEEDED");
                if (org.omg.sysml.util.FeatureUtil.getValuationFor(feature) != null) {
                    throw new IllegalArgumentException("FEATURE_VALUE_REQUIRES_NATIVE_PROJECTION");
                }
                if (!feature.getOwnedFeature().isEmpty()) throw new IllegalArgumentException("STRUCTURED_PORT");
                String portId = "p" + ports.size();
                Map<String, Object> port = base(feature, portId);
                port.put("ownerId", id);
                ports.add(port);
                context.members.put(feature, portId);
            } else if ((!action && feature instanceof PartUsage && !(feature instanceof ViewUsage))
                    || (action && feature instanceof ActionUsage)) {
                if (action && !feature.eClass().getName().equals("ActionUsage")) {
                    throw new IllegalArgumentException("STRUCTURED_ACTION_NOTATION");
                }
                Context child = addNode(feature, context, branch);
                context.children.put(feature, child);
                context.members.put(feature, child.id);
            } else {
                throw new IllegalArgumentException("UNSUPPORTED_FEATURE_" + feature.eClass().getName());
            }
        }
        return context;
    }

    private void addEdges(Context context) {
        for (Feature feature : context.type.getFeature()) {
            if (feature.eResource() != context.type.eResource() || feature.isImpliedIncluded()
                    || !(feature instanceof Connector connector)) continue;
            addEdge(context, feature);
        }
    }

    private void addEdge(Context context, Feature feature) {
            Connector connector = (Connector) feature;
            if (edges.size() >= 800) throw new IllegalArgumentException("EDGE_BUDGET_EXCEEDED");
            if (action ? !(feature instanceof SuccessionAsUsage) : !(feature instanceof ConnectionUsage)) {
                throw new IllegalArgumentException("UNSUPPORTED_CONNECTOR");
            }
            List<Feature> ends = connector.getRelatedFeature();
            if (ends.size() != 2) throw new IllegalArgumentException("NON_BINARY_CONNECTOR");
            String source = resolve(context, ends.get(0));
            String target = resolve(context, ends.get(1));
            if (!action && (!source.startsWith("p") || !target.startsWith("p"))) {
                throw new IllegalArgumentException("NON_PORT_CONNECTOR");
            }
            Map<String, Object> edge = base(feature, "e" + edges.size());
            edge.put("source", source);
            edge.put("target", target);
            edge.put("kind", action ? "succession" : "connection");
            edge.put("contextId", context.id);
            edges.add(edge);
    }

    private String resolve(Context context, Feature endpoint) {
        return resolve(context, endpoint, 0);
    }

    private String resolve(Context context, Feature endpoint, int depth) {
        if (depth > 32) throw new IllegalArgumentException("ENDPOINT_REFERENCE_CYCLE");
        List<Feature> chain = endpoint.getChainingFeature();
        if (chain.isEmpty()) {
            String resolved = context.members.get(endpoint);
            if (resolved != null) return resolved;
            Feature reference = endpoint.getFeatureTarget();
            if (reference != endpoint && reference != null) return resolve(context, reference, depth + 1);
            throw new IllegalArgumentException("UNRESOLVED_ENDPOINT");
        }
        Context cursor = context;
        for (int i = 0; i < chain.size() - 1; i++) {
            cursor = cursor.children.get(chain.get(i));
            if (cursor == null) throw new IllegalArgumentException("UNRESOLVED_FEATURE_CHAIN");
        }
        return resolve(cursor, chain.get(chain.size() - 1), depth + 1);
    }

    static Map<String, Object> base(Element element, String id) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", id);
        result.put("name", text(element.getName()));
        result.put("sourceRef", text(element.getQualifiedName()));
        result.put("sourceElementId", text(element.getElementId()));
        String typeName = element instanceof Feature feature
            ? feature.getType().stream().filter(t -> t.eResource() == element.eResource())
                .map(t -> text(t.getName())).findFirst().orElse("") : "";
        result.put("typeName", typeName);
        String multiplicity = "";
        if (element instanceof Feature feature && feature.getMultiplicity() instanceof MultiplicityRange range) {
            int upper = range.valueOf(range.getUpperBound());
            // 官方模型用空 lowerBound 表示单一界限 [24]，valueOf(null) 的 -2 不是基数。
            int lower = range.getLowerBound() == null ? upper : range.valueOf(range.getLowerBound());
            if (lower == -2 || upper == -2) throw new IllegalArgumentException("EXPRESSION_MULTIPLICITY");
            if (lower != 1 || upper != 1) multiplicity = " [" + (lower == upper ? (upper == -1 ? "*" : String.valueOf(upper))
                : lower + ".." + (upper == -1 ? "*" : upper)) + "]";
        }
        result.put("multiplicity", multiplicity.trim());
        List<Map<String, Object>> lines = new ArrayList<>(wrap(text(element.getName()) + multiplicity, 330));
        if (!typeName.isBlank()) lines.addAll(wrap(": " + typeName, 330));
        result.put("labelLines", lines);
        return result;
    }

    static List<Map<String, Object>> wrap(String text, double limit) {
        if (text.length() > 20000) throw new IllegalArgumentException("LABEL_TOO_LARGE");
        List<Map<String, Object>> lines = new ArrayList<>();
        for (String paragraph : text.split("\\R")) {
            String line = "";
            for (int codePoint : paragraph.codePoints().toArray()) {
                String next = new String(Character.toChars(codePoint));
                if (!line.isEmpty() && FONT.getStringBounds(line + next, FONT_CONTEXT).getWidth() > limit) {
                    lines.add(Map.of("text", line, "width", FONT.getStringBounds(line, FONT_CONTEXT).getWidth(), "height", 20));
                    line = "";
                }
                line += next;
            }
            if (!line.isEmpty()) lines.add(Map.of("text", line, "width", FONT.getStringBounds(line, FONT_CONTEXT).getWidth(), "height", 20));
        }
        return lines;
    }

    private static String text(String value) { return value == null ? "" : value; }

    private static final class Context {
        final Type type;
        final String id;
        final IdentityHashMap<Feature, String> members = new IdentityHashMap<>();
        final IdentityHashMap<Feature, Context> children = new IdentityHashMap<>();
        Context(Type type, String id) { this.type = type; this.id = id; }
    }
}
