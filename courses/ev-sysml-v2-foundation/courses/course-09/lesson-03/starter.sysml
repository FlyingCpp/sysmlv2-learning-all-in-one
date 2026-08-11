package EV_C09_L03 {
  private import EV_Program_Baseline::*;
  private import VerificationCases::*;

  requirement def IsolationSafetyRequirement {
    doc /* 高压系统绝缘能力应不低于 minIsolationOhmPerVolt。 */
    subject system : HighVoltageSystem;
    attribute minIsolationOhmPerVolt : ScalarValues::Real;
    require constraint {
      system.designIsolationOhmPerVolt >= minIsolationOhmPerVolt
    }
  }

  requirement hvIsolation : IsolationSafetyRequirement {
    subject system : HighVoltageSystem;
    attribute :>> minIsolationOhmPerVolt = 500.0;
  }

  requirement def SafeStateRequirement {
    doc /* 故障样车应具备进入 SafeState 的能力。 */
    subject vehicle : ElectricVehicle;
    require constraint { vehicle.safeStateCapability == true }
  }

  requirement safeStateEntry : SafeStateRequirement {
    subject vehicle : ElectricVehicle;
  }

  verification def IsolationInspection {
    subject inspectedSystem : HighVoltageSystem;
    attribute requiredIsolationOhmPerVolt : ScalarValues::Real;
    attribute measuredIsolationOhmPerVolt : ScalarValues::Real;
    objective { verify hvIsolation; }
    // TODO 1: 添加 VerificationMethod 元数据，方法为 inspect
    // TODO 2: 添加 VerdictKind return，用 PassIf 判定绝缘观测值
  }

  verification def SafeStateDemonstration {
    subject testVehicle : ElectricVehicle;
    attribute safeStateObserved : ScalarValues::Boolean;
    objective { verify safeStateEntry; }
    // TODO 3: 添加 VerificationMethod 元数据，方法为 demo
    // TODO 4: 添加 inconclusive VerdictKind return，记录证据不完整
  }

  verification isolationInspection : IsolationInspection {
    subject inspectedSystem = evPrototype.hvSystem;
    attribute :>> requiredIsolationOhmPerVolt = hvIsolation.minIsolationOhmPerVolt;
    attribute :>> measuredIsolationOhmPerVolt =
      safetyTestEvidence.measuredIsolationOhmPerVolt;
  }

  verification safeStateDemonstration : SafeStateDemonstration {
    subject testVehicle = evPrototype;
    attribute :>> safeStateObserved = safetyTestEvidence.safeStateObserved;
  }

  satisfy hvIsolation by evPrototype.hvSystem;
  satisfy safeStateEntry by evPrototype;

  view def SafetyVerificationView specializes StandardViewDefinitions::GeneralView;
  view safetyVerificationView : SafetyVerificationView {
    expose hvIsolation;
    expose safeStateEntry;
    expose safetyTestEvidence;
    // TODO 5: 添加 expose isolationInspection
    // TODO 6: 添加 expose safeStateDemonstration
  }
}
