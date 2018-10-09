const snakeCase = require('lodash.snakecase');
const uniq = require('lodash.uniq');
const map = require('lodash.map');
const reduce = require('lodash.reduce');
const upperCase = require('lodash.uppercase');
const isString = require('lodash.isstring');
const isObject = require('lodash.isobject');
const path = require('path');
const {
  parseSchema, schemaName, render, objectToTemplateValue, applyRequired, getIdAttribute,
  readTemplates, isFileExistPromise, writeFilePromise, changeFormat, parseModelName,
} = require('./utils');

/**
 * モデル定義からモデルファイルを作成
 */

class ModelGenerator {
  constructor({outputDir = '', outputBaseDir = '', templatePath = {}, isV2, useFlow, usePropType, attributeConverter = str => str}) {
    this.outputDir = outputDir;
    this.outputBaseDir = outputBaseDir;
    this.templatePath = templatePath;
    this.isV2 = isV2;
    this.useFlow = useFlow;
    this.usePropType = usePropType;
    this.attributeConverter = attributeConverter;
    this.templates = readTemplates(['model', 'models', 'override', 'head', 'dependency', 'oneOf'], this.templatePath);
  }

  /**
   * モデル定義ごとに呼び出し
   * - モデルファイルを書き出す
   * - Promiseでモデル名(Petなど)を返す
   */
  writeModel(model, name) {
    const {properties, required} = model;
    const fileName = snakeCase(name);
    const idAttribute = getIdAttribute(model, name);
    if (!idAttribute) return;

    const {text, props} = this._renderBaseModel(name, applyRequired(properties, required), idAttribute);
    return writeFilePromise(path.join(this.outputBaseDir, `${fileName}.js`), text).then(() => {
      return this._writeOverrideModel(name, fileName, props).then(() => name);
    });
  }

  writeIndex(modelNameList) {
    const text = render(this.templates.models, {
      models: uniq(modelNameList).map((name) => ({fileName: snakeCase(name), name})),
    }, {
      head: this.templates.head,
    });
    return writeFilePromise(path.join(this.outputDir, 'index.js'), text);
  }

  _writeOverrideModel(name, fileName, props) {
    const overrideText = this._renderOverrideModel(name, fileName, props);
    const filePath = path.join(this.outputDir, `${fileName}.js`);
    return isFileExistPromise(filePath).then((isExist) => isExist || writeFilePromise(filePath, overrideText));
  }

  _prepareImportList(importList) {
    return uniq(importList).map(({modelName, filePath}) => {
      return {
        name: modelName,
        schemaName: schemaName(modelName),
        filePath: filePath ? filePath : snakeCase(modelName),
      }
    });
  }

  _prepareIdAttribute(idAttribute) {
    const splits = idAttribute.split('.');
    if (splits[0] === 'parent') {
      splits.shift();
      return `(value, parent) => parent${splits.map(str => `['${this.attributeConverter(str)}']`).join('')}`
    }
    if (splits.length === 1) {
      return `'${this.attributeConverter(splits[0])}'`;
    }
    return `(value) => value${splits.map(str => `['${this.attributeConverter(str)}']`).join('')}`
  }

  _renderBaseModel(name, properties, idAttribute) {
    const importList = [];
    const oneOfs = [];
    let oneOfsCounter = 1;
    const dependencySchema = parseSchema(properties, ({type, value}) => {
      if (type === 'model') {
        importList.push({modelName: value});
        return schemaName(value);
      }
      if (type === 'oneOf') {
        const key = `oneOfSchema${oneOfsCounter++}`;
        value.key = key;
        oneOfs.push(value);
        return key;
      }
    }, this.isV2);

    const props = {
      name, idAttribute: this._prepareIdAttribute(idAttribute),
      usePropTypes: this.usePropType,
      useFlow: this.useFlow,
      props: this._convertPropForTemplate(properties, dependencySchema),
      schema: objectToTemplateValue(changeFormat(dependencySchema, this.attributeConverter)),
      oneOfs: oneOfs.map((obj) => Object.assign(obj, {mapping: objectToTemplateValue(obj.mapping), propertyName: this._prepareIdAttribute(obj.propertyName)})),
      importList: this._prepareImportList(importList),
      getFlowTypes, getPropTypes, getDefaults
    };

    const text = render(this.templates.model, props, {
      head: this.templates.head,
      dependency: this.templates.dependency,
      oneOf: this.templates.oneOf,
    });

    return {text, props};
  }

  static get templatePropNames() {
    return [
      'type',
      'default',
      'enum'
    ];
  }

  _convertPropForTemplate(properties, dependencySchema = {}) {
    return map(properties, (prop, name) => {
      const base = {
        name: () => this.attributeConverter(name),
        type: this.generateTypeFrom(prop, dependencySchema[name]),
        alias: prop['x-attribute-as'],
        required: prop.required === true,
        isEnum: Boolean(prop.enum),
        isValueString: prop.type === 'string',
        propertyName: name,
        enumObjects: this.getEnumObjects(this.attributeConverter(name), prop.enum, prop['x-enum-key-attributes']),
        enumType: this._getEnumTypes(prop.type),
        items: prop.items
      };
      return this.constructor.templatePropNames.reduce((ret, key) => {
        ret[key] = ret[key] || properties[name][key];
        return ret;
      }, base);
    });
  }

  getEnumConstantName(enumName, propertyName) {
    const convertedName = upperCase(propertyName).split(' ').join('_');
    const convertedkey = upperCase(enumName).split(' ').join('_');
    return `${convertedName}_${convertedkey}`;
  }

  getEnumObjects(name, enums, enumKeyAttributes = []) {
    if (!enums) return false;
    return enums.map((current, index) => {
      const enumName = enumKeyAttributes[index] || current;
      return {
        'name': this.getEnumConstantName(enumName, name),
        'value': current,
      };
    });
  }

  _getEnumTypes(type) {
    switch (type) {
      case 'integer':
      case 'number':
        return 'number';
      default:
        return type;
    }
  }

  generateTypeFrom(prop, definition) {
    if (prop && prop.oneOf) {
      // for only model (ref)
      const candidates = prop.oneOf.map((obj) => parseModelName(obj.$ref || obj.$$ref, this.isV2));
      return {
        propType: `PropTypes.oneOfType([${candidates.map(c => `${c}PropType`).join(', ')}])`,
        flow: candidates.join(' | '),
      };
    }

    if (definition) {
      return {
        propType: this._generatePropTypeFromDefinition(definition),
        flow: this._generateFlowTypeFromDefinition(definition),
      };
    }

    /* 上記の分岐でcomponentsに定義されている型の配列のパターンは吸収されるため、*/
    /* ここではプリミティブ型の配列のパターンを扱う */
    if (prop.type === 'array' && prop.items && prop.items.type) {
      return {
        propType: `ImmutablePropTypes.listOf(${_getPropTypes(prop.items.type)})`,
        flow: `${this._getEnumTypes(prop.items.type)}[]`,
      };
    }

    if (prop.type === 'object' && prop.properties) {
      const props = reduce(prop.properties, (acc, value, key) => {
        acc[this.attributeConverter(key)] = _getPropTypes(value.type, value.enum);
        return acc;
      }, {});
      return {
        propType: `ImmutablePropTypes.mapContains(${JSON.stringify(props).replace(/"/g, '')})`
      }
    }
  }

  _generatePropTypeFromDefinition(definition) {
    let def;
    if (isString(definition)) {
      def = definition.replace(/Schema$/, '');
      return `${def}PropType`;
    }
    if (Array.isArray(definition)) {
      def = definition[0];
      const type = this._generatePropTypeFromDefinition(def);
      return `ImmutablePropTypes.listOf(${type})`;
    } else if (isObject(definition)) {
      const type = reduce(definition, (acc, value, key) => {
        acc[key] = this._generatePropTypeFromDefinition(value);
        return acc;
      }, {});
      return `ImmutablePropTypes.mapContains(${JSON.stringify(type).replace(/"/g, '')})`;
    }
  }

  _generateFlowTypeFromDefinition(definition) {
    let def;
    if (isString(definition)) {
      return definition.replace(/Schema$/, '');
    }
    if (Array.isArray(definition)) {
      def = definition[0];
      const type = this._generateFlowTypeFromDefinition(def);
      return `${type}[]`;
    } else if (isObject(definition)) {
      return reduce(definition, (acc, value, key) => {
        acc[key] = this._generateFlowTypeFromDefinition(value);
        return acc;
      }, {});
    }
  }

  _renderOverrideModel(name, fileName, {props}) {
    const enums = props.filter((prop) => prop.enumObjects).reduce((acc, prop) => acc.concat(prop.enumObjects.reduce((acc, eo) => acc.concat(eo.name), [])), []);
    return render(this.templates.override, {
      name, fileName, enums,
      usePropTypes: this.usePropType,
    }, {
      head: this.templates.head,
    });
  }
}

function getPropTypes() {
  return _getPropTypes(this.type, this.enum, this.enumObjects);
}

function _getPropTypes(type, enums, enumObjects) {
  if (enumObjects) {
    const nameMap = enumObjects.map(current => current.name);
    return `PropTypes.oneOf([${nameMap.join(', ')}])`;
  } else if (enums) {
    return `PropTypes.oneOf([${enums.map(n => type === 'string' ? `'${n}'` : n).join(', ')}])`;
  }
  switch (type) {
    case 'integer':
    case 'number':
      return 'PropTypes.number';
    case 'string':
      return 'PropTypes.string';
    case 'boolean':
      return 'PropTypes.bool';
    case 'array':
      return 'PropTypes.array';
    default:
      return type && type.propType ? type.propType : 'PropTypes.any';
  }
}

function getFlowTypes() {
  return _getFlowTypes(this.type, this.enum)
}

function _getFlowTypes(type, enums) {
  if (enums) {
   const typeList = enums.map(() => _getFlowTypes(type));
   return typeList.join(' | ');
  }
  switch (type) {
    case 'integer':
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    default:
      return type && type.flow ? type.flow : 'any';
  }
}

function getDefaults() {
  if (!this.default) { return 'undefined'; }
  if (this.enumObjects) {
    for (const enumObject of this.enumObjects) {
      if (enumObject.value === this.default) return enumObject.name;
    }
  }
  return this.type === 'string' ? `'${this.default}'` : this.default;
}

module.exports = ModelGenerator;
