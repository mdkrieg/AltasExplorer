jest.mock('fs');
jest.mock('../logger');

describe('AttributeService copyable support', () => {
  let fs;
  let AttributeService;

  beforeEach(() => {
    jest.resetModules();
    fs = require('fs');
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue([]);
    fs.readFileSync.mockReset();
    fs.writeFileSync.mockReset();
    fs.mkdirSync.mockReset();
    AttributeService = require('../attributes');
  });

  it('defaults copyable to false when older attribute files do not define it', () => {
    fs.readdirSync.mockReturnValue(['serial.json']);
    fs.readFileSync.mockReturnValue(JSON.stringify({
      name: 'Serial',
      description: 'Device serial',
      type: 'String',
      default: '',
      options: []
    }));

    const attrs = AttributeService.loadAttributes();

    expect(attrs.Serial.copyable).toBe(false);
  });

  it('persists copyable when creating an attribute', () => {
    AttributeService.createAttribute('Serial', 'Device serial', 'String', '', [], true);

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const savedJson = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(savedJson.copyable).toBe(true);
  });

  it('persists copyable when updating an attribute', () => {
    AttributeService.updateAttribute('Ticket', 'Issue tracker id', 'String', '', [], false);

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const savedJson = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(savedJson.copyable).toBe(false);
  });
});