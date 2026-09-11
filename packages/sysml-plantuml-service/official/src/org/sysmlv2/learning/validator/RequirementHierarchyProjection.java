package org.sysmlv2.learning.validator;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.HashSet;
import org.eclipse.xtext.nodemodel.util.NodeModelUtils;
import org.omg.sysml.lang.sysml.*;

/** 需求嵌套与 require/assume 特征来自官方对象；不把 satisfy 或引用约束推断为分解。 */
final class RequirementHierarchyProjection {
    private final List<Map<String, Object>> nodes = new ArrayList<>();
    private final List<Map<String, Object>> ports = new ArrayList<>();
    private final Map<String, Type> sourceTypes = new LinkedHashMap<>();
    private final List<Map<String, Object>> edges = new ArrayList<>();
    private final HashSet<String> relationKeys = new HashSet<>();

    static Map<String, Object> project(ViewUsage view) {
        try {
            RequirementHierarchyProjection projection = new RequirementHierarchyProjection();
            IdentityHashMap<Element, Boolean> selected = new IdentityHashMap<>();
            for (Element element : view.getExposedElement()) selected.put(element, true);
            for (Element element : view.getExposedElement()) {
                boolean nested = false;
                for (Element owner = element.getOwner(); owner != null; owner = owner.getOwner()) {
                    if (selected.containsKey(owner) && (owner instanceof PartDefinition || owner instanceof PartUsage
                            || owner instanceof RequirementDefinition || owner instanceof RequirementUsage)) { nested = true; break; }
                }
                if (nested) continue;
                if (!(element instanceof RequirementDefinition || element instanceof RequirementUsage
                        || element instanceof PartDefinition || element instanceof PartUsage)) {
                    throw new IllegalArgumentException("MIXED_REQUIREMENT_ROOTS");
                }
                projection.add((Type) element, "", new IdentityHashMap<>());
            }
            for (Map<String, Object> node : projection.nodes) if (!"".equals(node.get("parentId"))) {
                projection.relation(String.valueOf(node.get("parentId")), String.valueOf(node.get("id")),
                    "requirement".equals(node.get("role")) ? "required-requirement" : "part-membership");
            }
            projection.addVisibleRelations();
            return Map.of("status", "ready", "profile", "requirement-hierarchy", "nodes", projection.nodes,
                "ports", projection.ports, "edges", projection.edges, "viewName", String.valueOf(view.getQualifiedName()),
                "presentation", Map.of("exposedElementCount", view.getExposedElement().size(), "displayRootCount",
                    projection.nodes.stream().filter(n -> "".equals(n.get("parentId"))).count()));
        } catch (IllegalArgumentException error) {
            return Map.of("status", "unsupported", "reason", error.getMessage());
        }
    }

    private void relation(String source, String target, String kind) {
        if (source.equals(target) || !relationKeys.add(source + ":" + target + ":" + kind)) return;
        edges.add(Map.of("id", "h" + edges.size(), "source", source, "target", target, "kind", kind));
    }

    private void addVisibleRelations() {
        // 关系只能来自官方对象身份；同名、相同正文或相同 ID 文本不能用来猜测连线。
        for (var entry : sourceTypes.entrySet()) {
            Type type = entry.getValue();
            for (Specialization specialization : type.getOwnedSpecialization()) {
                String kind = specialization instanceof FeatureTyping ? "feature-typing"
                    : specialization instanceof Subclassification ? "subclassification" : null;
                if (kind == null) continue;
                for (var target : sourceTypes.entrySet()) if (target.getValue() == specialization.getGeneral()) {
                    relation(entry.getKey(), target.getKey(), kind);
                }
            }
            for (Feature feature : type.getFeature()) {
                if (!(feature.getOwningMembership() instanceof RequirementConstraintMembership membership)) continue;
                ReferenceSubsetting reference = feature.getOwnedReferenceSubsetting();
                Feature targetFeature = reference == null ? feature.getFeatureTarget() : reference.getReferencedFeature();
                if (targetFeature == feature || targetFeature == null) continue;
                List<Feature> chain = referenceChain(targetFeature, 0);
                if (!(chain.get(chain.size() - 1) instanceof RequirementUsage)) continue;
                String target = resolveReference(entry.getKey(), chain);
                if (target != null) relation(entry.getKey(), target, membership.getKind() == RequirementConstraintKind.ASSUMPTION
                    ? "assumed-reference" : "required-reference");
            }
        }
    }

    private List<Feature> referenceChain(Feature feature, int depth) {
        if (depth > 32) throw new IllegalArgumentException("REQUIREMENT_REFERENCE_CYCLE");
        if (!feature.getChainingFeature().isEmpty()) return feature.getChainingFeature();
        Feature target = feature.getFeatureTarget();
        return target != null && target != feature ? referenceChain(target, depth + 1) : List.of(feature);
    }

    private String parent(String id) {
        return String.valueOf(nodes.stream().filter(n -> id.equals(n.get("id"))).findFirst().orElseThrow().get("parentId"));
    }

    private String child(String id, Feature feature) {
        for (Map<String, Object> node : nodes) if (id.equals(node.get("parentId"))
            && sourceTypes.get(String.valueOf(node.get("id"))) == feature) return String.valueOf(node.get("id"));
        return null;
    }

    private String resolveReference(String context, List<Feature> chain) {
        // 与端口连接相同，沿官方 ChainingFeature 身份解析；优先保留定义/用法的当前显示上下文。
        for (String scope = context; !scope.isEmpty(); scope = parent(scope)) {
            String cursor = scope;
            for (Feature feature : chain) { cursor = child(cursor, feature); if (cursor == null) break; }
            if (cursor != null) return cursor;
        }
        // 局部视图允许链的前缀未暴露，但可见后缀必须逐层匹配；不按同名叶节点猜测。
        List<String> candidates = new ArrayList<>();
        for (var entry : sourceTypes.entrySet()) {
            String cursor = entry.getKey();
            int index = chain.size() - 1;
            while (index >= 0 && !cursor.isEmpty() && sourceTypes.get(cursor) == chain.get(index)) {
                index--; cursor = parent(cursor);
            }
            if (index < 0 || (cursor.isEmpty() && index < chain.size() - 1)) candidates.add(entry.getKey());
        }
        if (candidates.size() > 1) throw new IllegalArgumentException("AMBIGUOUS_REQUIREMENT_CONTEXT");
        return candidates.isEmpty() ? null : candidates.get(0);
    }

    private void add(Type type, String parentId, IdentityHashMap<Type, Boolean> ancestors) {
        if (nodes.size() >= 200 || ancestors.size() >= 12 || ancestors.containsKey(type)) {
            throw new IllegalArgumentException("PROJECTION_LIMIT_OR_RECURSION");
        }
        if (type instanceof SatisfyRequirementUsage || type instanceof ConcernUsage || type instanceof ViewpointUsage) {
            throw new IllegalArgumentException("SPECIALIZED_REQUIREMENT_RELATION");
        }
        IdentityHashMap<Type, Boolean> branch = new IdentityHashMap<>(ancestors);
        branch.put(type, true);
        String id = "n" + nodes.size();
        Map<String, Object> node = DiagramProjection.base(type, id);
        node.put("parentId", parentId);
        boolean requirement = type instanceof RequirementDefinition || type instanceof RequirementUsage;
        node.put("role", requirement ? "requirement" : "part");
        node.put("isDefinition", type instanceof Definition);
        String reqId = type instanceof RequirementDefinition definition ? definition.getReqId()
            : type instanceof RequirementUsage usage ? usage.getReqId() : "";
        node.put("reqId", reqId == null ? "" : reqId);
        node.put("documentationLines", DiagramProjection.wrap(type.getDocumentation().stream()
            .map(d -> d.getBody() == null ? "" : d.getBody()).reduce("", (a, b) -> a + b + "\n"), 310));
        List<Map<String, Object>> details = new ArrayList<>();
        node.put("details", details);
        nodes.add(node);
        sourceTypes.put(id, type);
        for (Feature feature : type.getFeature()) {
            if (feature.eResource() != type.eResource() || feature.isImpliedIncluded()) continue;
            if (!requirement && feature instanceof Connector) continue;
            if (!requirement && feature instanceof PortUsage) {
                if (ports.size() >= 1200) throw new IllegalArgumentException("PORT_BUDGET_EXCEEDED");
                Map<String, Object> port = DiagramProjection.base(feature, "p" + ports.size());
                port.put("ownerId", id);
                ports.add(port);
            } else if (feature instanceof PartUsage && !(feature.getOwningMembership() instanceof SubjectMembership)) {
                add(feature, id, branch);
            } else if (feature instanceof RequirementUsage && feature.getFeatureTarget() == feature) {
                if (feature.getOwningMembership() instanceof RequirementConstraintMembership membership
                        && membership.getKind() == RequirementConstraintKind.ASSUMPTION) {
                    throw new IllegalArgumentException("ASSUMED_REQUIREMENT_HIERARCHY");
                }
                add(feature, id, branch);
            } else {
                // 保留 subject、属性、require/assume 的原有文字；取官方 AST 对应文本，不重新解析源码。
                var syntax = NodeModelUtils.getNode(feature);
                if (syntax == null) throw new IllegalArgumentException("REQUIREMENT_FEATURE_WITHOUT_SOURCE");
                String body = NodeModelUtils.getTokenText(syntax);
                String kind = feature.getOwningMembership() instanceof SubjectMembership ? "subject"
                    : feature.getOwningMembership() instanceof RequirementConstraintMembership membership
                        ? (membership.getKind() == RequirementConstraintKind.ASSUMPTION ? "assume" : "require")
                    : feature instanceof AttributeUsage ? "attributes" : "features";
                details.add(Map.of("sourceElementId", String.valueOf(feature.getElementId()),
                    "kind", kind, "lines", DiagramProjection.wrap(body, 310)));
            }
        }
    }
}
