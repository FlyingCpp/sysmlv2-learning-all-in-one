package EV_C07_L03 {
  private import EV_Program_Baseline::*;
  private import EV_Requirement_Baseline::*;

  state def VehicleOperatingState {
    state Ready;
    state Charging;
    state SafeState;
  }

  requirement def FastChargeRequirement {
    doc /* 10% 到 80% SOC 的直流快充时间应不高于 maxChargeMinutes。 */
    subject vehicle : ElectricVehicle;
    attribute startSOCPercent : ScalarValues::Real;
    attribute endSOCPercent : ScalarValues::Real;
    attribute maxChargeMinutes : ScalarValues::Real;
    // TODO 1: 添加 socWindow assume constraint，限定 SOC 工况边界
    require constraint { vehicle.predictedChargeMinutes <= maxChargeMinutes }
  }

  requirement fastChargeTime : FastChargeRequirement {
    subject vehicle : ElectricVehicle;
    attribute :>> startSOCPercent = 10.0;
    attribute :>> endSOCPercent = 80.0;
    attribute :>> maxChargeMinutes = 30.0;
  }

  requirement def HighVoltageSafetyRequirement {
    doc /* 高压系统绝缘设计值应不低于 minIsolationOhmPerVolt。 */
    subject system : HighVoltageSystem;
    attribute maxNominalVoltageV : ScalarValues::Real;
    attribute minIsolationOhmPerVolt : ScalarValues::Real;
    // TODO 2: 添加 voltageBoundary assume constraint，限定额定电压
    require constraint {
      system.designIsolationOhmPerVolt >= minIsolationOhmPerVolt
    }
  }

  requirement hvIsolationSafety : HighVoltageSafetyRequirement {
    subject system : HighVoltageSystem;
    attribute :>> maxNominalVoltageV = 500.0;
    attribute :>> minIsolationOhmPerVolt = 500.0;
  }

  // TODO 3: 添加 satisfy fastChargeTime by evPrototype
  // TODO 4: 添加 satisfy hvIsolationSafety by evPrototype.hvSystem

  verification def ChargeVerificationPreview {
    subject reviewVehicle : ElectricVehicle;
    objective {
      verify fastChargeTime;
    }
  }

  verification plannedChargeVerification : ChargeVerificationPreview {
    subject reviewVehicle = evPrototype;
  }

  view def RequirementResponsibilityView specializes StandardViewDefinitions::GeneralView;
  view requirementResponsibilityView : RequirementResponsibilityView {
    expose vehicleRange;
    expose evPrototype;
    // TODO 5: 添加 expose fastChargeTime
    // TODO 6: 添加 expose hvIsolationSafety
    expose plannedChargeVerification;
    expose VehicleOperatingState;
  }
}
