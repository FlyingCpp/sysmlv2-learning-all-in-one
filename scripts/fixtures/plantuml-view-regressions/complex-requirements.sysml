// 复杂需求布局回归：指标、约束和业务描述均为测试假设，不是飞行器认证要求或课程答案。
package ComplexRequirements {
    private import ScalarValues::Real;

    package Templates {
        requirement def <'T-BASE'> Criterion {
            doc /* 通用上界约束模板；实际指标及阈值由工程活动另行确定。 */
            attribute measured : Real;
            attribute threshold : Real;
            assume constraint { threshold > 0 }
            require constraint { measured <= threshold }
        }
        requirement def <'T-SAFE'> SafetyCriterion :> Criterion {
            doc /* 故障处理相关约束模板，仅用于验证继承关系的显示。 */
        }
        requirement def <'T-TIME'> TimingCriterion :> Criterion {
            doc /* 时间相关约束模板；本测试不配置实际时间单位或工程阈值。 */
        }
        requirement def <'T-QUAL'> QualityCriterion :> Criterion {
            doc /* 数据质量相关约束模板，用于多处定型及汇聚连线回归。 */
        }
    }

    package OperatingContext {
        requirement <'CTX-01'> nominalWeather {
            doc /* 示例运行环境处于已声明的气象边界内；这是条件假设，不是设计已满足的事实。 */
        }
        requirement <'CTX-02'> trainedOperator {
            doc /* 示例操作者已完成任务流程训练。 */
        }
        requirement <'CTX-03'> controlledAirspace {
            doc /* 示例任务空域条件在测试开始前由独立检查活动确认。 */
        }
    }

    package SystemSpecification {
        requirement def <'SYS-000'> MissionRequirements {
            doc /* 四层需求结构：系统目标、需求域、功能组、叶需求。跨域引用保留真实关系，不把引用重复展开成需求树。 */
            assume OperatingContext::nominalWeather;
            assume OperatingContext::trainedOperator;
            require OperatingContext::controlledAirspace;

            requirement <'SYS-100'> flightSafety {
                doc /* 飞行安全域：覆盖感知、故障识别及任务恢复。 */
                requirement <'SYS-110'> sensing {
                    requirement <'SYS-111'> accuracy : Templates::QualityCriterion;
                    requirement <'SYS-112'> latency : Templates::TimingCriterion;
                }
                requirement <'SYS-120'> faultDetection {
                    requirement <'SYS-121'> coverage : Templates::SafetyCriterion;
                    requirement <'SYS-122'> latency : Templates::TimingCriterion;
                }
                requirement <'SYS-130'> recovery {
                    doc /* 在测试故障条件触发后，系统应进入已指定的恢复过程，并向操作者提供可辨识的状态反馈；此长中文正文验证卡片换行、边界及连线路由。 */
                    requirement <'SYS-131'> safeTransition : Templates::SafetyCriterion;
                    requirement <'SYS-132'> latency : Templates::TimingCriterion;
                    require energyManagement.reserve.available;
                }
            }

            requirement <'SYS-200'> energyManagement {
                doc /* 能源管理域：覆盖估计、储备和保护；与恢复过程存在跨域依赖。 */
                requirement <'SYS-210'> estimation {
                    requirement <'SYS-211'> accuracy : Templates::QualityCriterion;
                    requirement <'SYS-212'> latency : Templates::TimingCriterion;
                }
                requirement <'SYS-220'> reserve {
                    requirement <'SYS-221'> available : Templates::SafetyCriterion;
                    requirement <'SYS-222'> prediction : Templates::QualityCriterion;
                }
                requirement <'SYS-230'> protection {
                    requirement <'SYS-231'> isolation : Templates::SafetyCriterion;
                    requirement <'SYS-232'> latency : Templates::TimingCriterion;
                    require flightSafety.faultDetection.coverage;
                }
            }

            requirement <'SYS-300'> communication {
                doc /* 通信域：覆盖指令、遥测和链路恢复。 */
                requirement <'SYS-310'> command {
                    requirement <'SYS-311'> integrity : Templates::QualityCriterion;
                    requirement <'SYS-312'> latency : Templates::TimingCriterion;
                }
                requirement <'SYS-320'> telemetry {
                    requirement <'SYS-321'> accuracy : Templates::QualityCriterion;
                    requirement <'SYS-322'> freshness : Templates::TimingCriterion;
                }
                requirement <'SYS-330'> linkRecovery {
                    requirement <'SYS-331'> reconnectTransition : Templates::SafetyCriterion;
                    requirement <'SYS-332'> latency : Templates::TimingCriterion;
                    require flightSafety.recovery.safeTransition;
                }
            }

            requirement <'SYS-400'> missionExecution {
                doc /* 任务执行域：覆盖起飞、航线和着陆。 */
                requirement <'SYS-410'> takeoff {
                    requirement <'SYS-411'> readiness : Templates::SafetyCriterion;
                    requirement <'SYS-412'> latency : Templates::TimingCriterion;
                    require energyManagement.reserve.available;
                }
                requirement <'SYS-420'> routeTracking {
                    requirement <'SYS-421'> accuracy : Templates::QualityCriterion;
                    requirement <'SYS-422'> continuity : Templates::QualityCriterion;
                    require communication.command.integrity;
                }
                requirement <'SYS-430'> landing {
                    requirement <'SYS-431'> stability : Templates::SafetyCriterion;
                    requirement <'SYS-432'> latency : Templates::TimingCriterion;
                    require flightSafety.sensing.accuracy;
                }
            }
        }
        requirement <'INST-000'> baseline : MissionRequirements;
    }

    // requireView 是视图用法名称，官方视图类型仍为 GeneralView。
    view requireView : StandardViewDefinitions::GeneralView {
        expose SystemSpecification::MissionRequirements;
        expose Templates::Criterion;
        expose Templates::SafetyCriterion;
        expose Templates::TimingCriterion;
        expose Templates::QualityCriterion;
        expose OperatingContext::nominalWeather;
        expose OperatingContext::trainedOperator;
        expose OperatingContext::controlledAirspace;
    }
    view hierarchyView : StandardViewDefinitions::GeneralView {
        expose SystemSpecification::MissionRequirements;
    }
    view definitionAndUsageView : StandardViewDefinitions::GeneralView {
        expose SystemSpecification::MissionRequirements;
        expose SystemSpecification::baseline;
        expose Templates::Criterion;
        expose Templates::SafetyCriterion;
        expose Templates::TimingCriterion;
        expose Templates::QualityCriterion;
        expose OperatingContext::nominalWeather;
        expose OperatingContext::trainedOperator;
        expose OperatingContext::controlledAirspace;
    }
    view focusedSafetyView : StandardViewDefinitions::GeneralView {
        expose SystemSpecification::MissionRequirements::flightSafety;
        expose SystemSpecification::MissionRequirements::energyManagement::reserve;
        expose Templates::SafetyCriterion;
        expose Templates::TimingCriterion;
        expose Templates::QualityCriterion;
    }
}
