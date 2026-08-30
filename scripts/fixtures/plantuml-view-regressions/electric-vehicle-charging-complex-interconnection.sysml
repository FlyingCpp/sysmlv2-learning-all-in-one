package ElectricVehicleCharging {

  item def PlugInRequest;
  item def ChargeCommand;
  item def ChargeCompleteSignal;
  item def ChargeRequest;
  item def ChargerEnable;
  item def PowerFlow;
  item def ThermalStatus;
  item def CoolingCommand;
  item def StopCommand;

  part def Contactor {
    port a;
    port b;
  }

  part def CellGroup {
    port positive;
    port negative;
    port sense;
    port cool;
  }

  part def ModuleSensor {
    port cellSense;
    port diag;
  }

  part def BatteryModule {
    port powerIn;
    port powerOut;
    port sense;
    port coolIn;

    part cellGroupA : CellGroup;
    part cellGroupB : CellGroup;
    part moduleSensor : ModuleSensor;

    connect powerIn to cellGroupA.positive;
    connect cellGroupA.negative to cellGroupB.positive;
    connect cellGroupB.negative to powerOut;
    connect cellGroupA.sense to moduleSensor.cellSense;
    connect cellGroupB.sense to moduleSensor.cellSense;
    connect moduleSensor.diag to sense;
    connect coolIn to cellGroupA.cool;
    connect cellGroupA.cool to cellGroupB.cool;
  }

  part def CoolingPlate {
    port coolIn;
    port coolOut;
  }

  part def PackSensor {
    port cellSense;
    port diag;
  }

  part def BatteryPack {
    port powerIn;
    port sense;
    port coolIn;

    part mainContactor : Contactor;
    part batteryModule1 : BatteryModule;
    part batteryModule2 : BatteryModule;
    part batteryModule3 : BatteryModule;
    part batteryModule4 : BatteryModule;
    part coolingPlate : CoolingPlate;
    part packSensor : PackSensor;

    connect powerIn to mainContactor.b;
    connect mainContactor.a to batteryModule1.powerIn;
    connect batteryModule1.powerOut to batteryModule2.powerIn;
    connect batteryModule2.powerOut to batteryModule3.powerIn;
    connect batteryModule3.powerOut to batteryModule4.powerIn;
    connect batteryModule4.powerOut to powerIn;
    connect batteryModule1.sense to packSensor.cellSense;
    connect batteryModule2.sense to packSensor.cellSense;
    connect batteryModule3.sense to packSensor.cellSense;
    connect batteryModule4.sense to packSensor.cellSense;
    connect packSensor.diag to sense;
    connect coolIn to coolingPlate.coolIn;
    connect coolingPlate.coolOut to batteryModule1.coolIn;
    connect coolingPlate.coolOut to batteryModule2.coolIn;
    connect coolingPlate.coolOut to batteryModule3.coolIn;
    connect coolingPlate.coolOut to batteryModule4.coolIn;
  }

  part def OnBoardCharger {
    port acIn;
    port dcOut;
  }

  part def BatteryManagementSystem {
    port comm;
    port battSense;
  }

  part def ThermalManagementSystem {
    port coolOut;
  }

  part def ChargingPort {
    port plug;
    port ctrl;
  }

  part def ElectricVehicle {
    part battery : BatteryPack;
    part obc : OnBoardCharger;
    part bms : BatteryManagementSystem;
    part tms : ThermalManagementSystem;
    part chargePort : ChargingPort;

    connect chargePort.plug to obc.acIn;
    connect obc.dcOut to battery.powerIn;
    connect chargePort.ctrl to bms.comm;
    connect bms.battSense to battery.sense;
    connect tms.coolOut to battery.coolIn;
  }

  part def ChargingConnector {
    port plug;
  }

  part def ChargingStation {
    part connector : ChargingConnector;
  }

  action def ChargingProcess {
    action plugIn;
    then action handshake;
    then action powerTransfer;
    then action stopCharging;
  }

  part chargingSession {
    part vehicle : ElectricVehicle {
      event occurrence plugInReq;
      then event occurrence chargeCmd;
      then event occurrence chargeDone;

      part redefines chargePort : ChargingPort {
        event occurrence portReq;
        then event occurrence portCmd;
        then event occurrence portStop;
      }

      part redefines bms : BatteryManagementSystem {
        event occurrence bmsReq;
        then event occurrence bmsEnable;
        then event occurrence bmsStop;
        then event occurrence bmsDone;
      }

      part redefines obc : OnBoardCharger {
        event occurrence obcEnable;
        then event occurrence obcPower;
      }

      part redefines battery : BatteryPack {
        event occurrence battPower;
        then event occurrence battStatus;
        then event occurrence battCool;
      }

      part redefines tms : ThermalManagementSystem {
        event occurrence tmsStatus;
        then event occurrence tmsCool;
      }
    }

    part station : ChargingStation {
      event occurrence plugInAck;
      then event occurrence chargeStart;
      then event occurrence chargeStop;
    }

    connect vehicle.chargePort.plug to station.connector.plug;

    message plugIn of PlugInRequest[1]
      from vehicle.plugInReq
      to station.plugInAck;

    message startCharging of ChargeCommand[1]
      from station.chargeStart
      to vehicle.chargeCmd;

    message chargeRequested of ChargeRequest[1]
      from vehicle.chargePort.portReq
      to vehicle.bms.bmsReq;

    message enableCharger of ChargerEnable[1]
      from vehicle.bms.bmsEnable
      to vehicle.obc.obcEnable;

    message powerIn of PowerFlow[1]
      from vehicle.obc.obcPower
      to vehicle.battery.battPower;

    message thermalReport of ThermalStatus[1]
      from vehicle.battery.battStatus
      to vehicle.tms.tmsStatus;

    message coolingCommand of CoolingCommand[1]
      from vehicle.tms.tmsCool
      to vehicle.battery.battCool;

    message stopRequested of StopCommand[1]
      from vehicle.bms.bmsStop
      to vehicle.chargePort.portStop;

    message finishCharging of ChargeCompleteSignal[1]
      from vehicle.bms.bmsDone
      to station.chargeStop;
  }

  part ev : ElectricVehicle;
  part cs : ChargingStation;

  view chargingSequence : StandardViewDefinitions::SequenceView {
    expose chargingSession;
  }

  view chargingFunctions : StandardViewDefinitions::ActionFlowView {
    expose ChargingProcess;
  }

  view vehicleInterconnection : StandardViewDefinitions::InterconnectionView {
    expose ElectricVehicle;
    expose ev;
    expose BatteryPack;
    expose BatteryModule;
    expose CellGroup;
    expose Contactor;
    expose CoolingPlate;
    expose PackSensor;
    expose ModuleSensor;
  }
}
