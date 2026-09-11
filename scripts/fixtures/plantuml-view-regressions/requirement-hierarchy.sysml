// 渲染回归模型：验证需求层级、正文与 require/assume 分区；不作为车型需求或课程答案。
package RequirementHierarchyRegression {
    part def Vehicle;
    requirement def <'REQ-000'> ThermalRequirements {
        doc /* 系统应支持电池热管理与座舱热管理。 */
        subject vehicle : Vehicle;
        requirement <'REQ-100'> batteryManagement {
            doc /* 电池热管理应包含温度监测与回路控制能力。 */
            requirement <'REQ-110'> temperatureMonitoring {
                doc /* 监测电池温度，为热管理控制提供输入。 */
                attribute sensorCount : ScalarValues::Integer;
                assume constraint { sensorCount <= 100 }
                require constraint { sensorCount >= 1 }
            }
            requirement <'REQ-120'> coolantRouting {
                doc /* 根据运行工况协调冷却液回路。 */
            }
        }
        requirement <'REQ-200'> cabinManagement {
            doc /* 支持座舱舒适性相关的热管理功能。 */
        }
    }
    view requirementsOverview : StandardViewDefinitions::GeneralView {
        expose ThermalRequirements;
    }
    requirement <'REQ-INSTANCE'> installedRequirements : ThermalRequirements;
    view installedOverview : StandardViewDefinitions::GeneralView {
        expose installedRequirements;
    }
    requirement referencedRequirement;
    requirement referenceHolder {
        require referencedRequirement;
    }
    view referenceOverview : StandardViewDefinitions::GeneralView {
        expose referenceHolder;
    }
}
