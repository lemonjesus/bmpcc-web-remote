const services = {
  deviceInfo: {
    uuid: "0000180a-0000-1000-8000-00805f9b34fb",
    characteristics: {
      manufacturerName: "00002a29-0000-1000-8000-00805f9b34fb",
      cameraModel: "00002a24-0000-1000-8000-00805f9b34fb",
    }
  },
  cameraService: {
    uuid: "291d567a-6d75-11e6-8b77-86f30ca893d3",
    characteristics: {
      outgoing: "5dd3465f-1aee-4299-8493-d2eca2f8e1bb",
      incoming: "b864e140-76a0-416a-bf30-5876504537d9",
      timecode: "6d8f2110-86f1-41bf-9afb-451d87e976c8",
      status: "7fe8691d-95dc-4fc5-8abd-ca74339b51b9",
      deviceName: "ffac0c52-c9fb-41a0-b063-cc76282eb89c",
      protocolVersion: "8f1fd018-b508-456f-8f82-3d392bee2706",
    }
  }
}

class BMPCC {
  constructor() {
    this.cameraManufacturer = null;
    this.cameraModel = null;
    this.device = null;
    this.server = null;
    this.params = {};
    this.timecode = 0;
    this.status = [];

    // download PROTOCOL.json
    fetch('PROTOCOL.json')
      .then(response => response.json())
      .then(data => {
        console.log(data);
        this.protocol = data;
        this.protocol.groups.forEach(group => {
          this.params[group.normalized_name] = {};
          group.parameters.forEach(parameter => {
            this.params[group.normalized_name][parameter.normalized_parameter] = null;
            if(parameter.index.length != 0) {
              this.params[group.normalized_name][parameter.normalized_parameter] = new Array(parameter.index.length).fill(null);
            }
          });
        });
      });
  }

  async connect() {
    let options = {};
    options.filters = [
      {namePrefix: 'A:'}
    ];

    options.optionalServices = [services.deviceInfo.uuid, services.cameraService.uuid];

    console.log('Requesting Bluetooth Device...');
    this.device = await navigator.bluetooth.requestDevice(options);

    console.log('Connecting to GATT Server...');
    this.server = await this.device.gatt.connect();

    this.cameraManufacturer = await this.getStringCharacteristic(services.deviceInfo.uuid, services.deviceInfo.characteristics.manufacturerName);
    this.cameraModel = await this.getStringCharacteristic(services.deviceInfo.uuid, services.deviceInfo.characteristics.cameraModel);

    let service = await this.server.getPrimaryService(services.cameraService.uuid);
    let incomingCharacteristic = await service.getCharacteristic(services.cameraService.characteristics.incoming);
    await incomingCharacteristic.startNotifications();
    incomingCharacteristic.addEventListener('characteristicvaluechanged', this.handleIncoming.bind(this));

    let timecodeCharacteristic = await service.getCharacteristic(services.cameraService.characteristics.timecode);
    await timecodeCharacteristic.startNotifications();
    timecodeCharacteristic.addEventListener('characteristicvaluechanged', this.handleTimecode.bind(this));

    let statusCharacteristic = await service.getCharacteristic(services.cameraService.characteristics.status);
    await statusCharacteristic.startNotifications();
    statusCharacteristic.addEventListener('characteristicvaluechanged', this.handleStatus.bind(this));
  }

  async getStringCharacteristic(serviceUuid, characteristicUuid) {
    let service = await this.server.getPrimaryService(serviceUuid);
    let characteristic = await service.getCharacteristic(characteristicUuid);
    let value = await characteristic.readValue();
    let decoder = new TextDecoder('utf-8');
    return decoder.decode(value);
  }

  handleIncoming(event) {
    let a = [];
    for (let i = 0; i < event.target.value.byteLength; i++) {
      a.push(event.target.value.getUint8(i));
    }
    console.log('Incoming> ' + a);

    // parse the incoming message
    // Ignore the message if it doesn't start with 0xFF
    if(a[0] != 0xFF) return;

    // look up what we just received
    let group = this.protocol.groups.find(group => group.id == a[4]);
    if(!group) return;

    let parameter = group.parameters.find(parameter => parameter.id == a[5]);
    if(!parameter) return;

    // how should we decode it?
    let value;
    switch(parameter.type) {
      case 'int8':
        value = a[6];
        break;
      case 'int16':
        value = this.make16(a[9], a[8]);
        break;
      case 'int32':
        value = this.make32(a[11], a[10], a[9], a[8]);
        break;
      case 'int64':
        value = this.make64(a[15], a[14], a[13], a[12], a[11], a[10], a[9], a[8]);
        break;
      case 'fixed16':
        value = this.make16(a[9], a[8]) / 2048;
        break;
      case 'string':
        let decoder = new TextDecoder('utf-8');
        value = decoder.decode(value);
        break;
      default:
        console.log('Unknown type: ' + parameter.type);
        value = a.splice(6); // just return the raw bytes
        return;
    }

    // update our status
    this.params[group.normalized_name][parameter.normalized_parameter] = value;
  }

  handleTimecode(event) {
    let a = [];
    for (let i = 0; i < event.target.value.byteLength; i++) {
      a.push(event.target.value.getUint8(i));
    }
    console.log('Timecode> ' + a);
    this.raw_timecode = a
    this.timecode = `${a[11].toString(16).padStart(2, '0')}:${a[10].toString(16).padStart(2, '0')}:${a[9].toString(16).padStart(2, '0')}:${a[8].toString(16).padStart(2, '0')}`
  }

  handleStatus(event) {
    let a = [];
    for (let i = 0; i < event.target.value.byteLength; i++) {
      a.push(event.target.value.getUint8(i));
    }
    console.log('Status> ' + a);
    this.raw_status = a[0];

    let state = [];
    if(this.raw_status & 0x01) state.push('On');
    if(this.raw_status & 0x02) state.push('Connected');
    if(this.raw_status & 0x04) state.push('Paired');
    if(this.raw_status & 0x08) state.push('Versions Verified');
    if(this.raw_status & 0x10) state.push('Initial Payload Received');
    if(this.raw_status & 0x20) state.push('Camera Ready');

    this.status = state;
  }

  async setParam(groupId, paramId, index, value) {
    let group = this.protocol.groups.find(group => group.id == groupId);
    if(!group) return;

    let parameter = group.parameters.find(parameter => parameter.id == paramId);
    if(!parameter) return;

    // how should we encode it?
    let bytes, type;
    switch(parameter.type) {
      case 'int8':
        bytes = [value];
        type = 1;
        break;
      case 'int16':
        bytes = [value & 0xFF, (value >> 8) & 0xFF];
        type = 2;
        break;
      case 'int32':
        bytes = [value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF, (value >> 24) & 0xFF];
        type = 3;
        break;
      case 'int64':
        bytes = [value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF, (value >> 24) & 0xFF, (value >> 32) & 0xFF, (value >> 40) & 0xFF, (value >> 48) & 0xFF, (value >> 56) & 0xFF];
        type = 4;
        break;
      case 'fixed16':
        value = value * 2048;
        bytes = [value & 0xFF, (value >> 8) & 0xFF];
        type = 128;
        break;
      case 'string':
        let encoder = new TextEncoder('utf-8');
        bytes = encoder.encode(value);
        type = 5;
        break;
      default:
        console.log('Unknown type: ' + parameter.type);
        return;
    }

    // pad bytes to 4-byte boundary
    while(bytes.length % 4 != 0) {
      bytes.push(0x00);
    }

    let operation = 0x00; // when is this 1?

    // build the packet
    let packet = [0xFF, bytes.length + 4, 0x00, 0x00, groupId, paramId, type, index, ...bytes];
    await this.sendPacket(packet);
  }

  async sendPacket(packet) {
    console.log('Outgoing> ' + packet)
    packet = new Uint8Array(packet);
    let service = await this.server.getPrimaryService(services.cameraService.uuid);
    let outgoingCharacteristic = await service.getCharacteristic(services.cameraService.characteristics.outgoing);
    await outgoingCharacteristic.writeValue(packet);
  }

  make16(a, b) {
    return (a << 8) | b;
  }

  make32(a, b, c, d) {
    return (a << 24) | (b << 16) | (c << 8) | d;
  }

  make64(a, b, c, d, e, f, g, h) {
    return (a << 56) | (b << 48) | (c << 40) | (d << 32) | (e << 24) | (f << 16) | (g << 8) | h;
  }
}