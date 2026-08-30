package CjkLayout {
  requirement def FunctionalRequirement {
    doc /* 系统功能需求用于描述设备在复杂工况下必须完成的行为。 */
  }

  requirement goal001 : FunctionalRequirement {
    doc /* 系统应在复杂工况下保持安全运行并提供清晰可验证的故障诊断信息。 */
  }

  view cjkRequirementView : StandardViewDefinitions::GeneralView {
    expose FunctionalRequirement;
    expose goal001;
  }
}
