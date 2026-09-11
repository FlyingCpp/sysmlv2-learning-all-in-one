// 渲染回归：复现定义与使用同时 expose 的关系缺口，不作为课程答案。
package RequirementDefinitionRelations {
    requirement def <'BASE'> Capability { doc /* 能力需求模板。 */ }
    requirement def Cooling :> Capability;
    requirement def Heating;
    requirement def SystemRequirements {
        requirement cooling : Cooling;
        requirement heating : Heating;
    }
    requirement externalRequirement;
    requirement operatingAssumption;
    requirement referenceHolder {
        require externalRequirement;
        assume operatingAssumption;
    }
    view requirementOverview : StandardViewDefinitions::GeneralView {
        expose Capability;
        expose Cooling;
        expose Heating;
        expose SystemRequirements;
        expose externalRequirement;
        expose operatingAssumption;
        expose referenceHolder;
    }
}
